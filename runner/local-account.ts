import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { agentAccounts, jobs } from "../db/schema";
import { accountFor, credsProvider, recordRunAccount, seal, unseal, type Account, type CredsProvider } from "../lib/creds";
import type { HarnessChoice } from "../lib/settings";

// A local job runs on its owner's account (R9b): the credential is opened from Postgres into
// ~/.hive/creds/<userId>/<provider>/ and the thread starts on a T3 provider instance of that user,
// whose home path T3 hands to the CLI as CLAUDE_CONFIG_DIR or CODEX_HOME. Nothing here logs a secret.

/** The T3 drivers that take a per-user instance; any other harness keeps the Mac's own login. */
const DRIVERS = new Set(["claudeAgent", "codex"]);
/** codex_slot of a job holding a Codex account: one job at a time, since Codex rotates its refresh token (Q15). */
export const LOCAL_SLOT = "account:";

export const credsDir = (userId: string, provider: CredsProvider) => join(homedir(), ".hive", "creds", userId, provider);
const settingsPath = () => join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "userdata", "settings.json");

function writePrivate(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Puts the account's login where its provider reads it and returns the T3 instance that points there. */
export function materialize(userId: string, driver: string, secret: string): HarnessChoice["provider"] {
  const provider = credsProvider(driver);
  const dir = credsDir(userId, provider);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A setup-token is static and travels in the instance's environment; Codex's auth.json lives in its home.
  if (provider === "codex") writePrivate(join(dir, "auth.json"), secret);
  const id = `${driver}-${userId}`;
  const instance = {
    driver,
    enabled: true,
    ...(provider === "claude" && { environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret }] }),
    config: { homePath: dir },
  };
  let settings: { providerInstances?: Record<string, unknown> } = {};
  try {
    settings = JSON.parse(readFileSync(settingsPath(), "utf8"));
  } catch {
    // No settings file yet: T3 starts from its defaults.
  }
  mkdirSync(join(settingsPath(), ".."), { recursive: true });
  writePrivate(settingsPath(), `${JSON.stringify({ ...settings, providerInstances: { ...settings.providerInstances, [id]: instance } }, null, 2)}\n`);
  return id;
}

type Held = { driver: string; account: Account & { id: string } };

export type LocalRuntime = {
  account: (key: string, provider: CredsProvider) => ReturnType<typeof accountFor>;
  lease: (key: string, marker: string, slot: string) => Promise<string | undefined>;
  log: (event: string, detail: Record<string, unknown>) => void;
};

/** The accounts of one launch pass's local jobs, from the pick before the claim to the thread's start. */
export function localAccounts(rt: LocalRuntime) {
  const held = new Map<string, Held>();
  const note = (event: string, key: string, error: unknown) =>
    rt.log(event, { key, error: error instanceof Error ? error.message.split("\n")[0] : "unknown error" });
  return {
    /** Before the claim; false leaves the job queued, with the Mac's own login for any job that has no account. */
    async pick(entry: { key: string; owner?: string | null; harness: HarnessChoice }) {
      held.delete(entry.key);
      if (!entry.owner || !DRIVERS.has(entry.harness.provider)) return true;
      try {
        const account = await rt.account(entry.key, credsProvider(entry.harness.provider));
        if (account === "wait") return false;
        if (account?.id) held.set(entry.key, { driver: entry.harness.provider, account: { id: account.id, secret: account.secret } });
        return true;
      } catch (error) {
        note("local:no-account", entry.key, error);
        return false;
      }
    },
    /** After the claim: a Codex account goes to one job at a time, so a second job waits for it. */
    async lease(key: string, marker: string) {
      const one = held.get(key);
      if (!one || credsProvider(one.driver) !== "codex") return true;
      if (await rt.lease(key, marker, `${LOCAL_SLOT}${one.account.id}`)) return true;
      held.delete(key);
      rt.log("local:codex-lease-held", { key, account: one.account.id });
      return false;
    },
    /** The harness the thread starts on: the owner's instance when the job holds an account. */
    harness(entry: { key: string; owner?: string | null; harness: HarnessChoice }): HarnessChoice {
      const one = held.get(entry.key);
      return one ? { provider: materialize(entry.owner!, one.driver, one.account.secret), model: entry.harness.model } : entry.harness;
    },
    /** The thread runs: its runs are stamped with the account so its usage is the one that moves. */
    started: (key: string, threadId: string) => recordRunAccount(key, threadId, held.get(key)?.account.id ?? null),
  };
}

const privateKey = (env: Record<string, string | undefined>) => {
  if (!env.HIVE_CREDS_PRIVATE_KEY) throw new Error("HIVE_CREDS_PRIVATE_KEY is not set; cannot seal an account");
  return env.HIVE_CREDS_PRIVATE_KEY;
};

/**
 * Seals the auth.json Codex refreshed during a job back into its account, then deletes the plaintext
 * copy. Throws, and keeps the lease, when it cannot: the old refresh token no longer works, so the
 * refreshed file must not be lost.
 */
export async function resealLocal(jobKey: string, slot: string, env: Record<string, string | undefined> = process.env) {
  const [job] = await db.select({ owner: jobs.owner_id }).from(jobs).where(eq(jobs.key, jobKey));
  const file = job?.owner ? join(credsDir(job.owner, "codex"), "auth.json") : undefined;
  let text: string | undefined;
  try {
    text = file ? readFileSync(file, "utf8") : undefined;
  } catch {
    // The job never wrote one.
  }
  if (!file || !text) return "missing";
  if (typeof JSON.parse(text) !== "object") throw new Error("the refreshed Codex login is not a JSON object");
  const [row] = await db
    .select({ sealed: agentAccounts.sealed, disconnected: agentAccounts.disconnected_at })
    .from(agentAccounts)
    .where(eq(agentAccounts.id, slot.slice(LOCAL_SLOT.length)));
  if (!row || row.disconnected) return "gone";
  const key = privateKey(env);
  const changed = unseal(row.sealed, key) !== text;
  if (changed) {
    const publicKey = createPublicKey(createPrivateKey(key.replace(/\\n/g, "\n")))
      .export({ type: "spki", format: "pem" })
      .toString();
    await db
      .update(agentAccounts)
      .set({ sealed: seal(text, publicKey) })
      .where(eq(agentAccounts.id, slot.slice(LOCAL_SLOT.length)));
  }
  rmSync(file, { force: true });
  return changed ? "resealed" : "unchanged";
}
