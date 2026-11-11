import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

// R9a: sealed credentials and per-user account selection.
const { db } = await import("../db/client");
const { accountUsage, agentAccounts, jobs, runs, user } = await import("../db/schema");
const { config } = await import("../runner/config");
const { linearJob } = await import("./fixtures");
const { accountFor, credsProvider, newKeyPair, pickAccount, recordRunAccount, runnerDefaultClaudeToken, seal, unseal } = await import("../lib/creds");
const { RATE_LIMITED } = await import("../lib/creds");

const FAILED = /^Error: a sealed credential could not be opened$/;
const pair = newKeyPair();
const escaped = (pem: string) => pem.trim().replace(/\n/g, "\\n");

// Round trip, with real or \n-escaped PEM, and never the same bytes twice.
const token = "sk-ant-oat-secret-token";
const sealed = seal(token, pair.publicKey);
assert.equal(unseal(sealed, pair.privateKey), token);
assert.equal(unseal(seal(token, escaped(pair.publicKey)), escaped(pair.privateKey)), token, "keys from an env line open too");
assert.ok(!sealed.toString("latin1").includes(token), "the token is not in the sealed bytes");
assert.notDeepEqual(seal(token, pair.publicKey), sealed, "each seal is fresh");

// Wrong key, tampering and junk all fail with the one fixed message.
assert.throws(() => unseal(sealed, newKeyPair().privateKey), FAILED, "another private key cannot open it");
for (const at of [0, 1, 33, 45, sealed.length - 1]) {
  const bad = Buffer.from(sealed);
  bad[at] = bad[at]! ^ 1;
  assert.throws(() => unseal(bad, pair.privateKey), FAILED, `a flipped byte at ${at} fails`);
}
assert.throws(() => unseal(sealed.subarray(0, 20), pair.privateKey), FAILED, "a short blob fails");
assert.throws(() => unseal(sealed, "not a key"), FAILED, "a bad key fails without its detail");

// A tag cut to 4 bytes is refused, not read as a short tag.
const tagAt = 1 + 32 + 12;
const shortTag = Buffer.concat([sealed.subarray(0, tagAt), sealed.subarray(tagAt, tagAt + 4), sealed.subarray(tagAt + 16)]);
assert.throws(() => unseal(shortTag, pair.privateKey), FAILED, "a 4-byte tag fails");

assert.deepEqual([credsProvider("claudeAgent"), credsProvider("codex"), credsProvider("cursor")], ["claude", "codex", "codex"]);
assert.equal(runnerDefaultClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "t" }), "t");
assert.equal(runnerDefaultClaudeToken({ CLAUDE_CODE_OAUTH_TOKEN: "" }), undefined);

// pickAccount, pure: the owner's, else the pool's, never anyone else's.
let n = 0;
const row = (id: string, owner_id: string | null, extra: Partial<Parameters<typeof pickAccount>[0][number]> = {}) => ({
  id,
  owner_id,
  provider: "claude" as const,
  sealed: Buffer.alloc(0),
  disconnected_at: null,
  created_at: new Date(1_700_000_000_000 + n++),
  ...extra,
});
const pick = (rows: ReturnType<typeof row>[], owner: string | null, provider: "claude" | "codex" = "claude") =>
  (pickAccount(rows, owner, provider) as { id: string } | undefined)?.id;
assert.equal(pick([row("a1", "A"), row("b1", "B"), row("pool", null)], "A"), "a1", "A's job gets A's account");
assert.equal(pick([row("b1", "B")], "A"), undefined, "A's job never gets B's account, even when it is the only row");
assert.equal(pick([row("b1", "B"), row("pool", null)], "A"), "pool", "an owner without an account gets the pool's");
assert.equal(pick([row("a1", "A", { disconnected_at: new Date() }), row("pool", null)], "A"), "pool", "a disconnected account is skipped");
assert.equal(pick([row("a1", "A"), row("pool", null)], null), "pool", "a job with no owner gets the pool's, not A's");
assert.equal(pick([row("a2", "A"), row("a1", "A", { created_at: new Date(1) })], "A"), "a1", "the oldest account wins");
assert.equal(pick([row("a1", "A", { provider: "codex" })], "A"), undefined, "the provider must match");

// accountFor, against the database.
const A = "creds-user-a";
const B = "creds-user-b";
const keys = { a: "CRD-1", b: "CRD-2", none: "CRD-3" };
const key = { HIVE_CREDS_PRIVATE_KEY: pair.privateKey };
const account = (id: string, owner_id: string | null, secret: string, provider: "claude" | "codex" = "claude") => ({
  id,
  owner_id,
  provider,
  kind: "subscription" as const,
  label: id,
  sealed: seal(secret, pair.publicKey),
  created_at: new Date(1_700_000_000_000 + n++),
});
const ids = ["creds-a", "creds-b", "creds-pool", "creds-a-codex"];
await db.delete(agentAccounts).where(inArray(agentAccounts.id, ids));
await db.delete(runs).where(inArray(runs.job_key, Object.values(keys)));
await db.delete(jobs).where(inArray(jobs.key, Object.values(keys)));
await db.delete(user).where(inArray(user.id, [A, B]));
await db.insert(user).values([
  { id: A, name: "A", email: "creds-a@unibuz.com.au", role: "engineer" },
  { id: B, name: "B", email: "creds-b@unibuz.com.au", role: "engineer" },
]);
await db
  .insert(jobs)
  .values([
    linearJob(`creds-${keys.a}`, keys.a, { owner_id: A }),
    linearJob(`creds-${keys.b}`, keys.b, { owner_id: B }),
    linearJob(`creds-${keys.none}`, keys.none),
  ]);
try {
  const secretOf = async (jobKey: string, provider: "claude" | "codex" = "claude", fallback: string | null = "runner-token") =>
    accountFor(jobKey, provider, fallback ?? undefined, key);

  // No rows: the runner default, or nothing.
  assert.deepEqual(await secretOf(keys.a), { id: null, secret: "runner-token" }, "no rows: the runner default");
  assert.equal(await secretOf(keys.a, "claude", null), null, "no rows and no default: nothing");

  await db
    .insert(agentAccounts)
    .values([account("creds-b", B, "token-of-b"), account("creds-pool", null, "token-of-pool"), account("creds-a", A, "token-of-a")]);
  assert.deepEqual(await secretOf(keys.a), { id: "creds-a", secret: "token-of-a" }, "A's job runs on A's account");
  assert.deepEqual(await secretOf(keys.b), { id: "creds-b", secret: "token-of-b" }, "B's job runs on B's");
  assert.deepEqual(await secretOf(keys.none), { id: "creds-pool", secret: "token-of-pool" }, "an owner-less job runs on the pool's");
  assert.deepEqual(await secretOf("CRD-gone"), { id: "creds-pool", secret: "token-of-pool" }, "so does a job that is gone");

  // R10a: the owner's account under 95% of its 5h window, else the pool's; each attempt records its account.
  const meter = async (account_id: string, used_pct: number) => {
    await db.delete(accountUsage).where(eq(accountUsage.account_id, account_id));
    await db.insert(accountUsage).values({ account_id, window: "5h", used_pct, read_at: new Date() });
  };
  const stamp = async (thread: string, branch: string, accountId: string) => {
    const at = new Date();
    await db.insert(runs).values({ session_id: `creds-${thread}`, job_key: keys.a, branch, t3_thread_id: thread, started_at: at, last_event_at: at });
    await recordRunAccount(keys.a, thread, accountId);
  };
  const ranOn = () => db.select({ branch: runs.branch, account: runs.account_id }).from(runs).where(eq(runs.job_key, keys.a)).orderBy(runs.branch);
  const failed = (attempt: number, previous_failure: string | null) => db.update(jobs).set({ attempt, previous_failure }).where(eq(jobs.key, keys.a));
  await meter("creds-a", 50);
  assert.deepEqual(await secretOf(keys.a), { id: "creds-a", secret: "token-of-a" }, "1.1: the owner under 95% runs on its own account");
  await stamp("t-1", "hive/CRD-1", "creds-a");
  assert.deepEqual(await ranOn(), [{ branch: "hive/CRD-1", account: "creds-a" }], "1.1: runs.account_id is the owner's");
  await failed(2, null);
  await meter("creds-a", 95);
  assert.deepEqual(await secretOf(keys.a), { id: "creds-pool", secret: "token-of-pool" }, "1.2: at 95% the pool account runs");

  const pool = config.factory.pool;
  await meter("creds-pool", 95);
  pool.pauseInstead = true;
  assert.equal(await secretOf(keys.a), "wait", "1.4: pool at its threshold with pauseInstead on waits");
  pool.pauseInstead = false;

  await meter("creds-a", 10);
  await meter("creds-pool", 10);
  await failed(2, `Watchdog stopped this run: ${RATE_LIMITED} (stage implementing).`);
  assert.deepEqual(await secretOf(keys.a), { id: "creds-pool", secret: "token-of-pool" }, "1.3: the owner's account just rate-limited, so the pool's runs");
  await stamp("t-2", "hive/CRD-1-a2", "creds-pool");
  const ran = (await ranOn()).map((r) => `${r.branch}:${r.account}`);
  assert.deepEqual(ran, ["hive/CRD-1:creds-a", "hive/CRD-1-a2:creds-pool"], "1.3: each attempt's runs.account_id says which account ran it");
  await failed(1, null);

  // The pool's rows beat the runner default, and B's account is never A's, whatever is left.
  await db.delete(agentAccounts).where(inArray(agentAccounts.id, ["creds-a", "creds-pool"]));
  assert.deepEqual(await secretOf(keys.a), { id: null, secret: "runner-token" }, "A has none and the pool is empty: the runner default, never B's");
  assert.equal(await secretOf(keys.a, "claude", null), null);

  // Codex rows are separate from Claude's.
  await db.insert(agentAccounts).values(account("creds-a-codex", A, '{"auth":"a-codex"}', "codex"));
  assert.deepEqual(await secretOf(keys.a, "codex", null), { id: "creds-a-codex", secret: '{"auth":"a-codex"}' });
  assert.deepEqual(await secretOf(keys.a, "claude", null), null, "a Codex account is not a Claude one");
  await db.insert(agentAccounts).values(account("creds-pool", null, "token-of-pool"));
  assert.deepEqual(await secretOf(keys.a), { id: "creds-pool", secret: "token-of-pool" }, "1.5: a Codex-only owner gets a pool Claude account");
  await db.delete(agentAccounts).where(eq(agentAccounts.id, "creds-pool"));

  // A runner without the private key says so without the sealed bytes; one with another key gets the fixed error.
  await assert.rejects(accountFor(keys.b, "claude", undefined, {}), /^Error: HIVE_CREDS_PRIVATE_KEY is not set; cannot open account creds-b$/);
  await assert.rejects(accountFor(keys.b, "claude", undefined, { HIVE_CREDS_PRIVATE_KEY: newKeyPair().privateKey }), FAILED);

  // No run row yet: stamping the default or a missing row changes nothing and does not throw.
  await recordRunAccount(keys.a, "thread-1", null);
  await recordRunAccount(keys.a, "thread-1", "creds-a-codex");
} finally {
  await db.delete(runs).where(inArray(runs.job_key, Object.values(keys)));
  await db.delete(agentAccounts).where(inArray(agentAccounts.id, ids));
  await db.delete(jobs).where(inArray(jobs.key, Object.values(keys)));
  await db.delete(user).where(inArray(user.id, [A, B]));
}

console.log("creds regressions pass");
process.exit(0);
