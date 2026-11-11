import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { agentAccounts } from "../db/schema";
import { attemptBranch } from "./factory";

// Agent tokens are sealed to a public key before they reach Postgres (R9a): the panel holds only
// HIVE_CREDS_PUBLIC_KEY, runners hold HIVE_CREDS_PRIVATE_KEY and are the only code that opens one.
// Nothing here puts a token, key or crypto detail in an error.

type Env = Record<string, string | undefined>;

const VERSION = 1;
const INFO = "hive-creds-v1";
const KEY_LENGTH = 32;
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const HEADER = 1 + KEY_LENGTH + IV_LENGTH + TAG_LENGTH;

/** A key from an env var: real newlines or the `\n` escapes creds-keygen prints. */
const pem = (text: string) => text.replace(/\\n/g, "\n");

const aesKey = (shared: Buffer, ephemeral: Buffer) => Buffer.from(hkdfSync("sha256", shared, ephemeral, INFO, KEY_LENGTH));

/** X25519 key pair as PEM (public: spki, private: pkcs8). */
export function newKeyPair() {
  const { publicKey, privateKey } = generateKeyPairSync("x25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

/** Layout: version | ephemeral public key | iv | tag | ciphertext. */
export function seal(plaintext: string, publicKeyPem: string): Buffer {
  const recipient = createPublicKey(pem(publicKeyPem));
  const ephemeral = generateKeyPairSync("x25519");
  const ephemeralRaw = Buffer.from(ephemeral.publicKey.export({ format: "jwk" }).x!, "base64url");
  const key = aesKey(diffieHellman({ privateKey: ephemeral.privateKey, publicKey: recipient }), ephemeralRaw);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH });
  const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), ephemeralRaw, iv, cipher.getAuthTag(), body]);
}

/** Any failure, whatever its cause, is this one fixed error. */
export function unseal(sealed: Uint8Array, privateKeyPem: string): string {
  try {
    const bytes = Buffer.from(sealed);
    if (bytes.length < HEADER || bytes[0] !== VERSION) throw new Error();
    const ephemeralRaw = bytes.subarray(1, 1 + KEY_LENGTH);
    const iv = bytes.subarray(1 + KEY_LENGTH, 1 + KEY_LENGTH + IV_LENGTH);
    const tag = bytes.subarray(1 + KEY_LENGTH + IV_LENGTH, HEADER);
    if (tag.length !== TAG_LENGTH) throw new Error();
    const ephemeral = createPublicKey({ key: { kty: "OKP", crv: "X25519", x: ephemeralRaw.toString("base64url") }, format: "jwk" });
    const key = aesKey(diffieHellman({ privateKey: createPrivateKey(pem(privateKeyPem)), publicKey: ephemeral }), ephemeralRaw);
    const decipher = createDecipheriv("aes-256-gcm", key, iv, { authTagLength: TAG_LENGTH }).setAuthTag(tag);
    return Buffer.concat([decipher.update(bytes.subarray(HEADER)), decipher.final()]).toString("utf8");
  } catch {
    throw new Error("a sealed credential could not be opened");
  }
}

export type CredsProvider = "claude" | "codex";
/** The account provider for a T3 harness: Claude Code's driver is `claudeAgent`, anything else runs on Codex. */
export const credsProvider = (harnessProvider: string): CredsProvider => (harnessProvider === "claudeAgent" ? "claude" : "codex");

export type AccountRow = Pick<typeof agentAccounts.$inferSelect, "id" | "owner_id" | "provider" | "sealed" | "disconnected_at" | "created_at">;

/** R10a: the owner's account under 95% of its 5h window, else the lowest-use pool account, else "wait" (pool full, pauseInstead on). No pool row: undefined (Q17). */
export function pickAccount(
  rows: readonly AccountRow[],
  ownerId: string | null,
  provider: CredsProvider,
  usage: ReadonlyMap<string, number> = new Map(),
  pool: { threshold: number; pauseInstead: boolean } = { threshold: 90, pauseInstead: false },
  exclude: ReadonlySet<string> = new Set(),
): AccountRow | "wait" | undefined {
  const pct = (r: AccountRow) => usage.get(r.id) ?? 0;
  const live = rows
    .filter((r) => r.provider === provider && !r.disconnected_at && !exclude.has(r.id))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const own = ownerId === null ? undefined : live.find((r) => r.owner_id === ownerId && pct(r) < 95);
  const shared = live.filter((r) => r.owner_id === null);
  if (own || shared.length === 0) return own;
  if (pool.pauseInstead && shared.every((r) => pct(r) >= pool.threshold)) return "wait";
  return shared.reduce((best, r) => (pct(r) < pct(best) ? r : best));
}

/** The failure summary the watchdog writes for a rate-limited run; accountFor and the relaunch read it back. */
export const RATE_LIMITED = "the provider rate-limited its account";

/** An unsealed account; id null is the runner's own default login. */
export type Account = { id: string | null; secret: string };

/** The runner's own Claude token: the only read of this variable in runner/ and lib/. */
export const runnerDefaultClaudeToken = (env: Env = process.env) => env.CLAUDE_CODE_OAUTH_TOKEN || undefined;

/**
 * The login a job's sandbox runs on (R10a): see pickAccount, else the runner default (null when none), or "wait" for the pool.
 * After a rate limit it skips accounts earlier attempts ran on in the last 5h; an attempt keeps its account across wakes.
 * The DB client and config load here, not at import, so the panel can import this file.
 */
export async function accountFor(jobKey: string, provider: CredsProvider, runnerDefault: string | undefined, env: Env = process.env) {
  const { db } = await import("../db/client");
  const { accountUsage, agentAccounts, jobs, runs } = await import("../db/schema");
  const { config } = await import("../runner/config");
  const [job] = await db.select({ owner: jobs.owner_id, failure: jobs.previous_failure, attempt: jobs.attempt }).from(jobs).where(eq(jobs.key, jobKey));
  const owner = job?.owner ?? null;
  const rows = await db
    .select()
    .from(agentAccounts)
    .where(
      and(
        eq(agentAccounts.provider, provider),
        isNull(agentAccounts.disconnected_at),
        or(isNull(agentAccounts.owner_id), owner ? eq(agentAccounts.owner_id, owner) : undefined),
      ),
    );
  const ids = rows.map((r) => r.id);
  const metered = and(inArray(accountUsage.account_id, ids), eq(accountUsage.window, "5h"));
  const meters = rows.length ? await db.select({ id: accountUsage.account_id, pct: accountUsage.used_pct }).from(accountUsage).where(metered) : [];
  const branch = attemptBranch(jobKey, job?.attempt ?? 1);
  const prior = await db
    .select({ id: runs.account_id, branch: runs.branch, at: runs.last_event_at })
    .from(runs)
    .where(and(eq(runs.job_key, jobKey), isNotNull(runs.account_id)));
  const limited = job?.failure?.includes(RATE_LIMITED);
  const skip = new Set(prior.flatMap((r) => (limited && r.branch !== branch && r.at.getTime() > Date.now() - 5 * 3_600_000 ? [r.id!] : [])));
  // With no pool and no default, a full owner account still beats nothing, and a Claude job with every account skipped waits: the harness is never switched.
  const row =
    rows.find((r) => r.id === prior.find((p) => p.branch === branch)?.id) ??
    pickAccount(rows, owner, provider, new Map(meters.map((m) => [m.id, m.pct])), config.factory.pool, skip) ??
    (runnerDefault ? undefined : pickAccount(rows, owner, provider, new Map(), config.factory.pool, skip)) ??
    (rows.length > 0 && !runnerDefault && provider === "claude" ? "wait" : undefined);
  if (row === "wait") return row;
  if (!row) return runnerDefault ? { id: null, secret: runnerDefault } : null;
  if (!env.HIVE_CREDS_PRIVATE_KEY) throw new Error(`HIVE_CREDS_PRIVATE_KEY is not set; cannot open account ${row.id}`);
  return { id: row.id, secret: unseal(row.sealed, env.HIVE_CREDS_PRIVATE_KEY) };
}

/** Stamps the account on the job's run rows for this thread that have none yet; the default (null) stamps nothing. */
export async function recordRunAccount(jobKey: string, threadId: string, accountId: string | null) {
  if (!accountId) return;
  const { db } = await import("../db/client");
  const { runs } = await import("../db/schema");
  await db
    .update(runs)
    .set({ account_id: accountId })
    .where(and(eq(runs.job_key, jobKey), eq(runs.t3_thread_id, threadId), isNull(runs.account_id)));
}
