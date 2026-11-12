import "./test-guard";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs";
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
const CODEX = `echo "Open https://auth.example/codex/device"; echo "Enter code ABCD-12345"; sleep 1; printf '%s' '${AUTH}' > "$CODEX_HOME/auth.json"; echo "Logged in"`;
const CLAUDE = `echo "Visit https://claude.example/oauth/authorize?code=true"; read code; [ "$code" = "pasted-code" ] || exit 2; echo "Your token: ${TOKEN}"`;
script("codex", CODEX);
script("claude", CLAUDE);
process.env.PATH = `${bin}:${process.env.PATH}`;

const { db } = await import("../db/client");
const { accountLogins, agentAccounts, intents, user } = await import("../db/schema");
const { newKeyPair, unseal } = await import("../lib/creds");
const { cancelLogin, readLogin, writeCode, writeLogin } = await import("../lib/account-logins");
const { expireLogins, handleAccountLogin, loginRuntime, running } = await import("../runner/account-login");

const pair = newKeyPair();
process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey;
const stamp = Date.now();
const [A, B] = [`login-a-${stamp}`, `login-b-${stamp}`];
const lines: string[] = [];
const rt = {
  ...loginRuntime,
  pollMs: 50,
  urlWaitMs: 5_000,
  log: (event: string, fields: Record<string, unknown>) => lines.push(JSON.stringify({ event, ...fields })),
};
const states = (id: string) =>
  lines
    .map((l) => JSON.parse(l))
    .filter((l) => l.event === "login:status" && l.loginId === id)
    .map((l) => l.status);
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
  assert.deepEqual([shown?.status, shown?.url, shown?.code], ["waiting_code", "https://auth.example/codex/device", "ABCD-12345"]);
  await running.get(codex.id);
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
  assert.equal((await readLogin(db, A, claude.id))?.url, "https://claude.example/oauth/authorize?code=true");
  assert.equal(await writeCode(db, B, claude.id, "pasted-code"), false, "another user cannot answer it");
  assert.equal(await writeCode(db, A, claude.id, "pasted-code"), true);
  const codeIntent = (await db.select().from(intents).where(eq(intents.kind, "account_login"))).find((i) => i.detail?.includes("pasted-code"))!;
  assert.deepEqual(await handleAccountLogin(codeIntent, rt), { code: "stored" });
  const [scrubbed] = await db.select().from(intents).where(eq(intents.id, codeIntent.id));
  assert.equal(scrubbed!.detail?.includes("pasted-code"), false, "the code is scrubbed from the intent");
  await running.get(claude.id);
  assert.deepEqual(states(claude.id), ["pending", "waiting_code", "done"]);
  const [claudeRow] = (await accounts(A)).filter((r) => r.provider === "claude");
  assert.equal(unseal(claudeRow!.sealed, pair.privateKey), TOKEN);
  assert.equal((await db.select().from(accountLogins).where(eq(accountLogins.user_id, A))).length, 0);

  // A CLI that fails leaves a failed row and no account; cancelling and the ten minutes end a login.
  script("codex", 'echo "Open https://auth.example/codex/device"; echo "Enter code ABCD-12345"; exit 1');
  const failed = await started(B, "codex");
  await handleAccountLogin(failed.intent, rt);
  await running.get(failed.id);
  assert.equal((await readLogin(db, B, failed.id))?.status, "failed");
  assert.equal((await accounts(B)).length, 0);
  script("codex", `${CODEX}; sleep 5`);
  const cancelled = await started(B, "codex");
  await handleAccountLogin(cancelled.intent, rt);
  await cancelLogin(db, B, cancelled.id);
  await running.get(cancelled.id);
  assert.equal((await accounts(B)).length, 0, "a cancelled login connects nothing");
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
