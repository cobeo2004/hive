import "./test-guard";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";

// R9b: the login relay, with fake `codex` and `claude` CLIs on PATH (never the real ones, never a real account).
const bin = mkdtempSync(join(tmpdir(), "hive-fake-cli-"));
const script = (name: string, body: string) => {
  writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
  chmodSync(join(bin, name), 0o755);
};
const AUTH = '{"tokens":{"refresh_token":"codex-secret-refresh"}}';
const TOKEN = "sk-ant-oat01-claudesecrettoken0123456789";
// The real CLIs (probed 2026-11-12): Codex colours its output and works without a terminal; Claude prints nothing
// without one, takes seconds to show a link wrapped over lines, then asks "Paste code".
const SHOW = String.raw`printf '\033[1mOpen \033[36mhttps://auth.openai.com/codex/device\033[0m\n'; printf 'Enter code \033[1mDM2C-O3PW0\033[0m\n'`;
const CODEX = `${SHOW}; env > "${bin}/env.txt"; sleep 1; printf '%s' '${AUTH}' > "$CODEX_HOME/auth.json"; echo "Logged in"`;
// The prompt's spaces are cursor moves, and in raw mode a chunk longer than one key is a paste, so its \r is text:
// only an Enter written on its own submits (2.1.322).
const CLAUDE = `#!/usr/bin/env bun
if (!process.stdin.isTTY) process.exit(0);
await Bun.sleep(1000);
process.stdout.write("\\x1b[2mBrowser didn't open? Use the url below to sign in\\x1b[0m\\n");
process.stdout.write("\\x1b[36mhttps://claude.example/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.example\\n%2Fcb&state=xyz\\x1b[0m\\n");
process.stdout.write("Paste\\x1b[1Ccode\\x1b[1Chere\\x1b[1Cif\\x1b[1Cprompted\\x1b[1C>\\x1b[1C");
process.stdin.setRawMode(true);
let typed = "";
process.stdin.on("data", (d) => {
  const keys = d.toString();
  // The real CLI would sit forever with an Enter pasted into the text; fail fast instead of hanging the run.
  if (keys !== "\\r" && keys.includes("\\r")) process.exit(3);
  if (keys !== "\\r") return void (typed += keys);
  if (typed !== "pasted-code") process.exit(2);
  console.log("\\nYour token: ${TOKEN}");
  process.exit(0);
});
`;
script("codex", CODEX);
writeFileSync(join(bin, "claude"), CLAUDE);
chmodSync(join(bin, "claude"), 0o755);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { db } = await import("../db/client");
const { accountLogins, agentAccounts, intents, user } = await import("../db/schema");
const { newKeyPair, unseal } = await import("../lib/creds");
const { cancelLogin, readLogin, writeCode, writeLogin } = await import("../lib/account-logins");
const { expireLogins, finishLogin, handleAccountLogin, loginRuntime, running } = await import("../runner/account-login");

const pair = newKeyPair();
process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey;
process.env.HIVE_TEST_CANARY = "canary";
const stamp = Date.now();
const [A, B] = [`login-a-${stamp}`, `login-b-${stamp}`];
const lines: string[] = [];
const rt = {
  ...loginRuntime,
  pollMs: 50,
  urlWaitMs: 5_000,
  killMs: 200,
  log: (event: string, fields: Record<string, unknown>) => lines.push(JSON.stringify({ event, ...fields })),
};
const states = (id: string) => lines.filter((l) => l.includes('"login:status"') && l.includes(id)).map((l) => JSON.parse(l).status);
const alive = (pid: number) => spawnSync("kill", ["-0", String(pid)]).status === 0;
const leftovers = () => readdirSync(tmpdir()).filter((f) => f.startsWith("hive-login-"));
const accounts = (owner: string) => db.select().from(agentAccounts).where(eq(agentAccounts.owner_id, owner));
const started = async (owner: string, provider: "claude" | "codex", at?: Date) => {
  const id = await writeLogin(db, owner, provider, at);
  const intent = (await db.select().from(intents).where(eq(intents.kind, "account_login"))).find((i) => i.detail === JSON.stringify({ loginId: id }))!;
  return { id, intent };
};

try {
  await db.insert(user).values([A, B].map((id) => ({ id, name: id, email: `${id}@example.com` })));

  // Codex: pending -> waiting_code (link and code on the row) -> done; sealed account; row deleted; no token in any log line.
  const codex = await started(A, "codex");
  assert.equal((await readLogin(db, A, codex.id))?.status, "pending");
  assert.deepEqual(await handleAccountLogin(codex.intent, rt), { login: "waiting_code" });
  assert.deepEqual(await handleAccountLogin(codex.intent, rt), { login: "skipped" }, "a login that is not pending starts nothing");
  const shown = await readLogin(db, A, codex.id);
  assert.deepEqual([shown?.status, shown?.url, shown?.code], ["waiting_code", "https://auth.openai.com/codex/device", "DM2C-O3PW0"]);
  await running.get(codex.id);
  const seen = readFileSync(join(bin, "env.txt"), "utf8");
  assert.ok(
    /CODEX_HOME=/.test(seen) && /PATH=/.test(seen) && !/HIVE_CREDS|DATABASE_URL|HIVE_TEST_CANARY/.test(seen),
    "the CLI gets its home and PATH, not the runner's secrets",
  );
  assert.deepEqual(states(codex.id), ["pending", "waiting_code", "done"]);
  assert.equal((await db.select().from(accountLogins).where(eq(accountLogins.id, codex.id))).length, 0, "the login row is deleted");
  const [sealed] = await accounts(A);
  assert.deepEqual([sealed?.provider, sealed?.kind], ["codex", "subscription"]);
  assert.equal(unseal(sealed!.sealed, pair.privateKey), AUTH, "the sealed row holds auth.json");
  assert.deepEqual(leftovers(), [], "the temporary home is deleted");

  const again = await started(A, "codex");
  await handleAccountLogin(again.intent, rt);
  await running.get(again.id);
  assert.equal((await accounts(A)).length, 1, "signing in again replaces the connection");

  // Claude: the pasted code travels through an intent and leaves it; only the owner can send one.
  const claude = await started(A, "claude");
  await handleAccountLogin(claude.intent, rt);
  assert.equal(
    (await readLogin(db, A, claude.id))?.url,
    "https://claude.example/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fclaude.example%2Fcb&state=xyz",
  );
  assert.equal(await writeCode(db, B, claude.id, "pasted-code"), false, "another user cannot answer it");
  for (const bad of ["", "two words", "x".repeat(513), "a\nb"])
    assert.equal(await writeCode(db, A, claude.id, bad), false, "a code of the wrong shape is refused");
  assert.equal(await writeCode(db, A, claude.id, "pasted-code"), true);
  const codeIntent = (await db.select().from(intents).where(eq(intents.kind, "account_login"))).find((i) => i.detail?.includes("pasted-code"))!;
  assert.deepEqual(await handleAccountLogin(codeIntent, rt), { code: "stored" });
  const [scrubbed] = await db.select().from(intents).where(eq(intents.id, codeIntent.id));
  assert.equal(scrubbed!.detail?.includes("pasted-code"), false, "the code is scrubbed from the intent");
  // `cat` holds the pty open after the CLI exits, so a code that never submits would wait forever: bound it.
  const settled = await Promise.race([running.get(claude.id)!.then(() => true), new Promise((r) => setTimeout(() => r(false), 15_000))]);
  assert.ok(settled, "the Claude login finishes once the code is pasted and Enter pressed on its own");
  assert.deepEqual(states(claude.id), ["pending", "waiting_code", "done"]);
  const [claudeRow] = (await accounts(A)).filter((r) => r.provider === "claude");
  assert.equal(unseal(claudeRow!.sealed, pair.privateKey), TOKEN);

  // A CLI that fails leaves a failed row and no account; cancelling and the ten minutes end a login.
  script("codex", `${SHOW}; exit 1`);
  const failed = await started(B, "codex");
  await handleAccountLogin(failed.intent, rt);
  await running.get(failed.id);
  assert.equal((await readLogin(db, B, failed.id))?.status, "failed");
  script("codex", "exit 3");
  const dead = await started(B, "codex");
  assert.deepEqual(await handleAccountLogin(dead.intent, rt), { error: "the login did not start" }, "a CLI that never shows a link fails the start");
  assert.equal((await accounts(B)).length, 0);
  script("codex", `${SHOW}; sleep 30 & echo $! > "${bin}/pid"; wait`);
  const cancelled = await started(B, "codex");
  await handleAccountLogin(cancelled.intent, rt);
  await cancelLogin(db, B, cancelled.id);
  await running.get(cancelled.id);
  assert.equal((await accounts(B)).length, 0, "a cancelled login connects nothing");
  const pid = Number(readFileSync(join(bin, "pid"), "utf8"));
  for (let i = 0; i < 20 && alive(pid); i++) await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(alive(pid), false, "the CLI's own children die with it");
  assert.equal(await finishLogin({ id: cancelled.id, user_id: B, provider: "codex" }, AUTH), false, "a cancelled login is never sealed");
  assert.equal((await accounts(B)).length, 0);
  const stale = await started(B, "codex", new Date(Date.now() - 11 * 60_000));
  assert.deepEqual(await handleAccountLogin(stale.intent, rt), { login: "skipped" }, "a login past its ten minutes starts nothing");
  assert.ok((await expireLogins()) >= 1);
  assert.equal(await readLogin(db, B, stale.id), null, "an expired login is deleted");
  assert.deepEqual(leftovers(), []);

  const kept = lines.join("\n") + JSON.stringify(await db.select().from(intents).where(eq(intents.kind, "account_login")));
  assert.equal(/codex-secret|sk-ant/.test(kept), false, "no log line or intent holds a token");
} finally {
  await db.delete(intents).where(eq(intents.kind, "account_login"));
  await db.delete(accountLogins).where(inArray(accountLogins.user_id, [A, B]));
  await db.delete(agentAccounts).where(inArray(agentAccounts.owner_id, [A, B]));
  await db.delete(user).where(inArray(user.id, [A, B]));
}

console.log("account login regressions pass");
process.exit(0);
