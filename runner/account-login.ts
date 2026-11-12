import { type ChildProcess, type StdioOptions, spawn } from "node:child_process";
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
// Claude prints nothing without a terminal, so it runs in a pty, widened so its link is not wrapped. `cat |` because
// Node's stdin is a socket, which BSD script refuses.
const WIDE = "stty cols 2000; exec claude setup-token";
const PTY = process.platform === "darwin" ? `cat | script -q /dev/null sh -c '${WIDE}'` : `cat | script -qec '${WIDE}' /dev/null`;
const CLI = {
  codex: { argv: ["codex", "login", "--device-auth"], home: "CODEX_HOME", label: "ChatGPT" },
  claude: {
    argv: ["sh", "-c", PTY],
    home: "CLAUDE_CONFIG_DIR",
    label: "Claude",
  },
} as const;
const ESCAPES = /\u001b(?:\[[0-9;?]*[ -/]*[@-~]|\][^\u0007\u001b]*(?:\u0007|\u001b\\)|[()][A-Z0-9])/g;
const URL_IN = /https?:\/\/[^\s"'<>]+/;
const DEVICE_CODE = /\b[A-Z0-9]{4}-[A-Z0-9]{5}\b/;
const TOKEN = /sk-ant-[A-Za-z0-9_-]{20,}/;

export const loginRuntime = {
  log: (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...fields })),
  pollMs: 1_000,
  urlWaitMs: 60_000,
  killMs: 2_000,
  /** Claude 2.1.322 takes a long chunk as a paste, so an Enter inside it is text; Enter goes alone after this pause. */
  enterMs: 500,
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

/** SIGTERM, then SIGKILL, to the CLI's whole process group, so nothing it spawned outlives the login. */
async function stopGroup(proc: ChildProcess, graceMs: number) {
  const signal = (name: NodeJS.Signals) => {
    try {
      process.kill(-proc.pid!, name);
    } catch {
      // Already gone.
    }
  };
  signal("SIGTERM");
  await Promise.race([new Promise((resolve) => (proc.exitCode === null ? proc.once("exit", resolve) : resolve(0))), sleep(graceMs)]);
  signal("SIGKILL");
}

/** Deleting the live row is the commit point: a login cancelled or expired meanwhile is never sealed. */
export async function finishLogin(login: { id: string; user_id: string; provider: "claude" | "codex" }, secret: string, env: NodeJS.ProcessEnv = process.env) {
  const live = and(eq(accountLogins.id, login.id), gt(accountLogins.expires_at, new Date()));
  if (!(await db.delete(accountLogins).where(live).returning({ id: accountLogins.id })).length) return false;
  await connectAccount(login.user_id, login.provider, secret, env);
  return true;
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
  const { provider } = login;
  const status = (next: string) => rt.log("login:status", { loginId, provider, status: next });
  status("pending");
  const patch = (fields: Partial<typeof accountLogins.$inferInsert>) => db.update(accountLogins).set(fields).where(eq(accountLogins.id, loginId));
  const ended = () => rt.log("login:ended", { loginId, reason: "the login was cancelled or expired" });
  const fail = async (reason: string) => {
    await patch({ status: "failed" });
    rt.log("login:failed", { loginId, provider, status: "failed", reason });
  };

  const spec = CLI[provider];
  const home = mkdtempSync(join(tmpdir(), "hive-login-"));
  let child: ChildProcess | undefined;
  let handedOff = false;
  const cleanup = async () => {
    if (child) await stopGroup(child, rt.killMs);
    rmSync(home, { recursive: true, force: true });
  };
  try {
    // Only what the CLI needs: the runner's own secrets (HIVE_CREDS_*, DATABASE_URL, ...) never reach it.
    const { PATH, HOME, LANG } = env;
    const childEnv: Record<string, string | undefined> = { PATH, HOME, LANG, TERM: "xterm-256color", BROWSER: "true", [spec.home]: home };
    const [command, ...args] = spec.argv;
    const proc: ChildProcess = spawn(command, args, {
      detached: true,
      stdio: [provider === "claude" ? "pipe" : "ignore", "pipe", "pipe"] as StdioOptions,
      env: childEnv as NodeJS.ProcessEnv,
    });
    child = proc;
    let out = "";
    let exited: number | undefined;
    proc.stdout?.on("data", (chunk) => (out += chunk));
    proc.stderr?.on("data", (chunk) => (out += chunk));
    proc.stdin?.on("error", () => {});
    proc.on("error", () => (exited = 127));
    proc.on("close", (code) => (exited ??= code ?? 1));
    // The link, and for Codex its one-time code, show up in the CLI's output; the panel gets them from the row.
    const waiting = () => {
      const text = out.replace(ESCAPES, "").replace(/\r/g, "");
      if (provider === "claude") {
        // Its link may be wrapped over lines: everything from https:// to the "Paste code" prompt. Claude 2.1.322 draws
        // spaces as cursor moves, which ESCAPES strips, so the prompt can read "Pastecode".
        const from = text.indexOf("https://");
        const to = from < 0 ? -1 : text.slice(from).search(/Paste\s*code/);
        return to > 0 ? { url: text.slice(from, from + to).replace(/\s+/g, ""), code: null } : undefined;
      }
      const url = URL_IN.exec(text)?.[0];
      const device = DEVICE_CODE.exec(text.replace(URL_IN, ""))?.[0];
      return url && device ? { url, code: device } : undefined;
    };
    const deadline = Date.now() + rt.urlWaitMs;
    let shown = waiting();
    while (!shown && exited === undefined && Date.now() < deadline) {
      await sleep(100);
      shown = waiting();
    }
    if (!shown) throw new Error(exited === undefined ? "the login showed no link in time" : "the provider CLI could not be started or ended early");
    await patch({ status: "waiting_code", url: shown.url, code: shown.code });
    status("waiting_code");

    const background = (async () => {
      let delivered = false;
      while (exited === undefined && !(provider === "claude" && TOKEN.test(out))) {
        await sleep(rt.pollMs);
        const [row] = await db.select({ code: accountLogins.code }).from(accountLogins).where(live);
        if (!row) return ended();
        if (provider === "claude" && row.code && !delivered) {
          delivered = true;
          proc.stdin?.write(row.code);
          await sleep(rt.enterMs);
          proc.stdin?.write("\r");
          await patch({ code: null });
        }
      }
      const auth = join(home, "auth.json");
      const secret = provider === "claude" ? TOKEN.exec(out)?.[0] : existsSync(auth) ? readFileSync(auth, "utf8") : undefined;
      if (!secret || (provider === "codex" && exited !== 0)) return fail("the provider reported no login");
      if (!(await finishLogin({ id: loginId, user_id: login.user_id, provider }, secret, env))) return ended();
      status("done");
    })()
      .catch((error) => fail(error instanceof Error ? error.message : "the login could not be saved").catch(() => {}))
      .finally(async () => {
        await cleanup();
        running.delete(loginId);
      });
    running.set(loginId, background);
    handedOff = true;
    return { login: "waiting_code" };
  } catch (error) {
    await fail(error instanceof Error ? error.message : "the login could not start").catch(() => {});
    return { error: "the login did not start" };
  } finally {
    if (!handedOff) await cleanup();
  }
}
