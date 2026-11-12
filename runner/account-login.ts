import { spawn } from "node:child_process";
import { createPrivateKey, createPublicKey, randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, gt, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { accountLogins, agentAccounts, intents } from "../db/schema";
import { seal } from "../lib/creds";

// R9b: runs `codex login --device-auth` or `claude setup-token` in a temporary home, relays the link and code through account_logins,
// seals the result into agent_accounts and deletes the login row. The CLI's output holds the token: it is never logged or stored.

const detail = z.object({ loginId: z.string(), code: z.string().optional() });
const CLI = {
  codex: { command: "codex", args: ["login", "--device-auth"], home: "CODEX_HOME", label: "ChatGPT" },
  claude: { command: "claude", args: ["setup-token"], home: "CLAUDE_CONFIG_DIR", label: "Claude" },
} as const;
const ESCAPES = /\u001b\[[0-9;?]*[ -/]*[@-~]|\u001b\]8;[^\u0007\u001b]*(?:\u0007|\u001b\\)/g;
const URL_IN = /https?:\/\/[^\s"'<>]+/;
const DEVICE_CODE = /\b[A-Z0-9]{4,}-[A-Z0-9]{4,}\b/;
const TOKEN = /sk-ant-[A-Za-z0-9_-]{20,}/;

export const loginRuntime = {
  log: (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })),
  pollMs: 1_000,
  urlWaitMs: 60_000,
};
export const running = new Map<string, Promise<void>>();
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Seals the secret to the runners' key into the user's own subscription account, replacing an earlier connection of that provider. */
export async function connectAccount(userId: string, provider: "claude" | "codex", secret: string, env: Record<string, string | undefined> = process.env) {
  const key = env.HIVE_CREDS_PRIVATE_KEY;
  if (!key) throw new Error("HIVE_CREDS_PRIVATE_KEY is not set; cannot seal an account");
  const publicKey = createPublicKey(createPrivateKey(key.replace(/\\n/g, "\n")))
    .export({ type: "spki", format: "pem" })
    .toString();
  const sealed = seal(secret, publicKey);
  const own = and(eq(agentAccounts.owner_id, userId), eq(agentAccounts.provider, provider), eq(agentAccounts.kind, "subscription"));
  const [existing] = await db.select({ id: agentAccounts.id }).from(agentAccounts).where(own);
  if (existing) await db.update(agentAccounts).set({ sealed, disconnected_at: null }).where(eq(agentAccounts.id, existing.id));
  else
    await db
      .insert(agentAccounts)
      .values({ id: randomUUID(), owner_id: userId, provider, kind: "subscription", label: CLI[provider].label, sealed, created_by: userId });
}

/** Rows past their ten minutes; a login still running notices its row is gone and stops. */
export async function expireLogins() {
  return (await db.delete(accountLogins).where(lt(accountLogins.expires_at, new Date())).returning({ id: accountLogins.id })).length;
}

export async function handleAccountLogin(
  intent: { id: string; detail: string | null },
  rt: typeof loginRuntime = loginRuntime,
  env: NodeJS.ProcessEnv = process.env,
) {
  const { loginId, code } = detail.parse(JSON.parse(intent.detail ?? "null"));
  const live = and(eq(accountLogins.id, loginId), gt(accountLogins.expires_at, new Date()));
  if (code !== undefined) {
    // The pasted code goes to the login's row for the runner that holds the CLI, and leaves the intent.
    await db
      .update(intents)
      .set({ detail: JSON.stringify({ loginId }) })
      .where(eq(intents.id, intent.id));
    const claude = and(live, eq(accountLogins.status, "waiting_code"), eq(accountLogins.provider, "claude"));
    const stored = await db.update(accountLogins).set({ code }).where(claude).returning({ id: accountLogins.id });
    return { code: stored.length > 0 ? "stored" : "ignored" };
  }
  const [login] = await db
    .select()
    .from(accountLogins)
    .where(and(live, eq(accountLogins.status, "pending")));
  if (!login) return { login: "skipped" };
  if (!env.HIVE_CREDS_PRIVATE_KEY) throw new Error("HIVE_CREDS_PRIVATE_KEY is not set; cannot seal an account");
  const { provider, user_id: userId } = login;
  const spec = CLI[provider];
  const status = (next: string) => rt.log("login:status", { loginId, provider, status: next });
  status("pending");

  const home = mkdtempSync(join(tmpdir(), "hive-login-"));
  const child = spawn(spec.command, [...spec.args], { env: { ...env, [spec.home]: home }, stdio: ["pipe", "pipe", "pipe"] });
  let out = "";
  let exited: number | undefined;
  child.stdout.on("data", (chunk) => (out += chunk));
  child.stderr.on("data", (chunk) => (out += chunk));
  child.stdin.on("error", () => {});
  child.on("error", () => (exited = 127));
  child.on("close", (status) => (exited ??= status ?? 1));
  const patch = (fields: Partial<typeof accountLogins.$inferInsert>) => db.update(accountLogins).set(fields).where(eq(accountLogins.id, loginId));
  const fail = async (reason: string) => {
    await patch({ status: "failed" });
    rt.log("login:failed", { loginId, provider, status: "failed", reason });
  };

  // The link, and for Codex its one-time code, show up in the CLI's output; the panel gets them from the row.
  const waiting = () => {
    const text = out.replace(ESCAPES, "");
    const url = URL_IN.exec(text)?.[0];
    const device = DEVICE_CODE.exec(text.replace(URL_IN, ""))?.[0];
    return url && (provider === "claude" || device) ? { url, code: provider === "codex" ? device : null } : undefined;
  };
  const deadline = Date.now() + rt.urlWaitMs;
  let shown = waiting();
  while (!shown && exited === undefined && Date.now() < deadline) {
    await sleep(100);
    shown = waiting();
  }
  const cleanup = () => {
    child.kill();
    rmSync(home, { recursive: true, force: true });
  };
  if (!shown) {
    await fail(exited === undefined ? "the login showed no link in time" : "the provider CLI could not be started or ended early");
    cleanup();
    return { error: "the login did not start" };
  }
  await patch({ status: "waiting_code", url: shown.url, code: shown.code });
  status("waiting_code");

  const background = (async () => {
    let delivered = false;
    while (exited === undefined && !(provider === "claude" && TOKEN.test(out))) {
      await sleep(rt.pollMs);
      const [row] = await db.select({ code: accountLogins.code }).from(accountLogins).where(live);
      if (!row) return rt.log("login:ended", { loginId, reason: "the login was cancelled or expired" });
      if (provider === "claude" && row.code && !delivered) {
        delivered = true;
        child.stdin.write(`${row.code}\n`);
        await patch({ code: null });
      }
    }
    const auth = join(home, "auth.json");
    const secret = provider === "claude" ? TOKEN.exec(out)?.[0] : existsSync(auth) ? readFileSync(auth, "utf8") : undefined;
    if (!secret || (provider === "codex" && exited !== 0)) return fail("the provider reported no login");
    await connectAccount(userId, provider, secret, env);
    status("done");
    await db.delete(accountLogins).where(eq(accountLogins.id, loginId));
  })()
    .catch(() => fail("the login could not be saved").catch(() => {}))
    .finally(() => {
      cleanup();
      running.delete(loginId);
    });
  running.set(loginId, background);
  return { login: "waiting_code" };
}
