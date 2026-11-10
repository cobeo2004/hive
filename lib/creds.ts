import { createCipheriv, createDecipheriv, createPrivateKey, createPublicKey, diffieHellman, generateKeyPairSync, hkdfSync, randomBytes } from "node:crypto";
import { and, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import type { agentAccounts } from "../db/schema";

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

/** R10a: the owner's account is used while its 5h window is under this. */
export const OWNER_CUTOFF_PCT = 95;
export type PoolLimits = { threshold: number; pauseInstead: boolean };

/**
 * R10a: the owner's account while under 95% of its 5h window, else the pool account with the lowest 5h
 * use, else "wait" when every pool account is at or above the threshold and pauseInstead is on. With no
 * pool row it returns undefined, and the runner default stands in for the pool (Q17). A missing meter
 * counts as 0%. The provider comes from the caller's harness, never from the accounts (Q19).
 */
export function pickAccount(
  rows: readonly AccountRow[],
  ownerId: string | null,
  provider: CredsProvider,
  usage: ReadonlyMap<string, number> = new Map(),
  pool: PoolLimits = { threshold: 90, pauseInstead: false },
  exclude: ReadonlySet<string> = new Set(),
): AccountRow | "wait" | undefined {
  const pct = (r: AccountRow) => usage.get(r.id) ?? 0;
  const live = rows
    .filter((r) => r.provider === provider && !r.disconnected_at && !exclude.has(r.id))
    .sort((a, b) => a.created_at.getTime() - b.created_at.getTime());
  const own = ownerId === null ? undefined : live.find((r) => r.owner_id === ownerId && pct(r) < OWNER_CUTOFF_PCT);
  if (own) return own;
  const shared = live.filter((r) => r.owner_id === null);
  if (shared.length === 0) return undefined;
  if (pool.pauseInstead && shared.every((r) => pct(r) >= pool.threshold)) return "wait";
  return shared.reduce((best, r) => (pct(r) < pct(best) ? r : best)); // stable: the oldest wins a tie
}

/** The failure summary the watchdog writes for a rate-limited run, and the marker accountFor and the relaunch read back. */
export const RATE_LIMITED = "the provider rate-limited its account";

const RATE_LIMIT = /\b429\b|rate[ _-]?limit|usage limit|too many requests/i;
const PROVIDER_ERROR = /API Error: 429|rate_limit_error|usage limit reached|hit your usage limit|too many requests/i;
/** A stopped thread that ended on the provider's rate limit: a failed run that says so, or any message carrying the provider's own error text. */
export const rateLimited = ({ status, lastMessage }: { status: string | null; lastMessage: string | null }) =>
  !!lastMessage && ((status === "failed" && RATE_LIMIT.test(lastMessage)) || PROVIDER_ERROR.test(lastMessage));

/** An unsealed account; id null is the runner's own default login. */
export type Account = { id: string | null; secret: string };

/** The runner's own Claude token: the only read of this variable in runner/ and lib/. */
export const runnerDefaultClaudeToken = (env: Env = process.env) => env.CLAUDE_CODE_OAUTH_TOKEN || undefined;

/**
 * The login a job's sandbox runs on (R10a): see pickAccount, then the runner's default when the pool has
 * no row (null when nothing is left), or "wait" for the team pool. After a rate-limited attempt it skips
 * every account that already ran the job. The DB client and config load here, not at import, so the panel
 * can import this file without them.
 */
export async function accountFor(
  jobKey: string,
  provider: CredsProvider,
  runnerDefault: string | undefined,
  env: Env = process.env,
): Promise<Account | null | "wait"> {
  const { db } = await import("../db/client");
  const { accountUsage, agentAccounts, jobs, runs } = await import("../db/schema");
  const { config } = await import("../runner/config");
  const [job] = await db.select({ owner: jobs.owner_id, failure: jobs.previous_failure }).from(jobs).where(eq(jobs.key, jobKey));
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
  const meters =
    rows.length === 0
      ? []
      : await db
          .select({ id: accountUsage.account_id, pct: accountUsage.used_pct })
          .from(accountUsage)
          .where(
            and(
              inArray(
                accountUsage.account_id,
                rows.map((r) => r.id),
              ),
              eq(accountUsage.window, "5h"),
            ),
          );
  // A manual retry after an ordinary failure goes back to the owner; only a rate limit moves on.
  const ran = job?.failure?.includes(RATE_LIMITED)
    ? await db
        .selectDistinct({ id: runs.account_id })
        .from(runs)
        .where(and(eq(runs.job_key, jobKey), isNotNull(runs.account_id)))
    : [];
  const skip = new Set(ran.flatMap((r) => (r.id ? [r.id] : [])));
  const usage = new Map(meters.map((m) => [m.id, m.pct]));
  // With no pool and no default, a full owner account still beats nothing: the harness is never switched.
  const row =
    pickAccount(rows, owner, provider, usage, config.factory.pool, skip) ??
    (runnerDefault ? undefined : pickAccount(rows, owner, provider, new Map(), config.factory.pool, skip));
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
