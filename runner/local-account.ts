import { createPrivateKey, createPublicKey } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq, isNull } from "drizzle-orm";
import { db } from "../db/client";
import { agentAccounts } from "../db/schema";
import { credsProvider, recordRunAccount, seal, unseal, type CredsProvider } from "../lib/creds";
import type { HarnessChoice } from "../lib/settings";

// A local job runs on its owner's account (R9b): the credential is opened from Postgres into
// ~/.hive/creds/<userId>/<provider>/ and the thread starts on a T3 provider instance of that user,
// whose home path T3 hands to the CLI as CLAUDE_CONFIG_DIR or CODEX_HOME. Nothing here logs a secret.

/** The T3 drivers that take a per-user instance; any other harness keeps the Mac's own login. */
const DRIVERS = new Set(["claudeAgent", "codex"]);
/** codex_slot of a job holding a Codex account: one job at a time, since Codex rotates its refresh token (Q15). */
export const LOCAL_SLOT = "account:";

/** The scope is the owner's user id, or `pool-<id>` for a pool account, so two jobs on different accounts never share a home. */
export const credsDir = (scope: string, provider: CredsProvider) => join(homedir(), ".hive", "creds", scope, provider);
const settingsPath = () => join(process.env.T3CODE_HOME ?? join(homedir(), ".t3"), "userdata", "settings.json");

function writePrivate(path: string, text: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, text, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Adds, or with no instance drops, a T3 provider instance; settings.json is written only when it changes. */
function setInstance(id: string, instance?: object) {
  const raw = existsSync(settingsPath()) ? readFileSync(settingsPath(), "utf8") : "";
  const settings: { providerInstances?: Record<string, unknown> } = raw ? JSON.parse(raw) : {};
  const instances = { ...settings.providerInstances };
  if (instance) instances[id] = instance;
  else if (id in instances) delete instances[id];
  else return;
  const text = `${JSON.stringify({ ...settings, providerInstances: instances }, null, 2)}\n`;
  if (text === raw) return;
  mkdirSync(join(settingsPath(), ".."), { recursive: true });
  writePrivate(settingsPath(), text);
}

/** Puts the account's login where its provider reads it and returns the T3 instance that points there. */
export function materialize(scope: string, driver: string, secret: string): HarnessChoice["provider"] {
  const provider = credsProvider(driver);
  const dir = credsDir(scope, provider);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  // A setup-token is static and travels in the instance's environment; Codex's auth.json lives in its home.
  if (provider === "codex") writePrivate(join(dir, "auth.json"), secret);
  const id = `${driver}-${scope}`;
  setInstance(id, {
    driver,
    enabled: true,
    ...(provider === "claude" && { environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: secret }] }),
    config: { homePath: dir },
  });
  return id;
}

/** Temp homes a crashed login left behind (runner/account-login.ts); run at runner start, before any login. */
export function sweepLogins() {
  for (const f of readdirSync(tmpdir())) if (f.startsWith("hive-login-")) rmSync(join(tmpdir(), f), { recursive: true, force: true });
}

type Held = { driver: string; id: string; scope: string; secret: string };

export type LocalRuntime = {
  lease: (key: string, marker: string, slot: string) => Promise<string | undefined>;
  log: (event: string, detail: Record<string, unknown>) => void;
};

const privateKey = (env: Record<string, string | undefined> = process.env) => {
  if (!env.HIVE_CREDS_PRIVATE_KEY) throw new Error("HIVE_CREDS_PRIVATE_KEY is not set; cannot seal an account");
  return env.HIVE_CREDS_PRIVATE_KEY;
};

/** The accounts of one launch pass's local jobs, from the pick before the claim to the thread's start. */
export function localAccounts(rt: LocalRuntime) {
  const held = new Map<string, Held>();
  return {
    /** Before the claim: the owner's own subscription for this provider, else the Mac's login (no pool, no API key, no waiting). False leaves the job queued. */
    async pick(entry: { key: string; owner?: string | null; harness: HarnessChoice }) {
      held.delete(entry.key);
      const { owner, harness } = entry;
      if (!owner || !DRIVERS.has(harness.provider)) return true;
      try {
        const own = and(
          eq(agentAccounts.owner_id, owner),
          eq(agentAccounts.provider, credsProvider(harness.provider)),
          eq(agentAccounts.kind, "subscription"),
          isNull(agentAccounts.disconnected_at),
        );
        const [row] = await db.select().from(agentAccounts).where(own).orderBy(agentAccounts.id).limit(1);
        // A disconnected account's instance (and its token) goes, so the job runs on the Mac's login.
        if (!row) setInstance(`${harness.provider}-${owner}`);
        else held.set(entry.key, { driver: harness.provider, id: row.id, scope: owner, secret: unseal(row.sealed, privateKey()) });
        return true;
      } catch (error) {
        rt.log("local:no-account", { key: entry.key, error: error instanceof Error ? error.message.split("\n")[0] : "unknown error" });
        return false;
      }
    },
    /** After the claim: a Codex account goes to one job at a time. When the owner's is busy a free pool account is used; with none the job waits. */
    async lease(key: string, marker: string) {
      const one = held.get(key);
      if (!one || credsProvider(one.driver) !== "codex") return true;
      if (await rt.lease(key, marker, `${LOCAL_SLOT}${one.id}`)) return true;
      const pool = await db
        .select()
        .from(agentAccounts)
        .where(
          and(isNull(agentAccounts.owner_id), eq(agentAccounts.provider, "codex"), eq(agentAccounts.kind, "api_key"), isNull(agentAccounts.disconnected_at)),
        );
      for (const row of pool) {
        if (!(await rt.lease(key, marker, `${LOCAL_SLOT}${row.id}`))) continue;
        // A pool account is an API key; Codex reads it from auth.json.
        held.set(key, { ...one, id: row.id, scope: `pool-${row.id}`, secret: JSON.stringify({ OPENAI_API_KEY: unseal(row.sealed, privateKey()) }) });
        return true;
      }
      held.delete(key);
      rt.log("local:codex-lease-held", { key, account: one.id });
      return false;
    },
    /** The harness the thread starts on: the owner's instance when the job holds an account. */
    harness(entry: { key: string; owner?: string | null; harness: HarnessChoice }): HarnessChoice {
      const one = held.get(entry.key);
      return one ? { provider: materialize(one.scope, one.driver, one.secret), model: entry.harness.model } : entry.harness;
    },
    /** A launch that failed after harness(): the plaintext login must not stay on disk. */
    discard(key: string) {
      const one = held.get(key);
      if (one) rmSync(join(credsDir(one.scope, "codex"), "auth.json"), { force: true });
    },
    /** The thread runs: its runs are stamped with the account so its usage is the one that moves. */
    started: (key: string, threadId: string) => recordRunAccount(key, threadId, held.get(key)?.id ?? null),
  };
}

/**
 * Seals the auth.json Codex refreshed during a job back into its account, then deletes the plaintext
 * copy. Throws, and keeps the lease, when it cannot: the old refresh token no longer works, so the
 * refreshed file must not be lost.
 */
export async function resealLocal(slot: string, env: Record<string, string | undefined> = process.env) {
  const id = slot.slice(LOCAL_SLOT.length);
  const [row] = await db
    .select({ owner: agentAccounts.owner_id, sealed: agentAccounts.sealed, disconnected: agentAccounts.disconnected_at, kind: agentAccounts.kind })
    .from(agentAccounts)
    .where(eq(agentAccounts.id, id));
  const file = join(credsDir(row?.owner ?? `pool-${id}`, "codex"), "auth.json");
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (!text) return "missing";
  // A pool API key never changes, and a disconnected account has nothing to seal into.
  if (!row || row.disconnected || row.kind === "api_key") {
    rmSync(file, { force: true });
    return row?.kind === "api_key" ? "static" : "gone";
  }
  if (typeof JSON.parse(text) !== "object") throw new Error("the refreshed Codex login is not a JSON object");
  const key = privateKey(env);
  const changed = unseal(row.sealed, key) !== text;
  if (changed) {
    const publicKey = createPublicKey(createPrivateKey(key.replace(/\\n/g, "\n")))
      .export({ type: "spki", format: "pem" })
      .toString();
    await db
      .update(agentAccounts)
      .set({ sealed: seal(text, publicKey) })
      .where(eq(agentAccounts.id, id));
  }
  rmSync(file, { force: true });
  return changed ? "resealed" : "unchanged";
}
