import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

// R27d: an owner opts an account in to the team pool; leases go own → shared or pool → blocked.
const { db } = await import("../db/client");
const { agentAccounts, jobs, runs, user } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { accountFor, newKeyPair, seal } = await import("../lib/creds");
const { setAccountShared } = await import("../lib/account-logins");
const { poolAccounts } = await import("../lib/pool-accounts");

const pair = newKeyPair();
const key = { HIVE_CREDS_PRIVATE_KEY: pair.privateKey };
const stamp = Date.now();
const [A, B, C] = ["a", "b", "c"].map((u) => `share-${u}-${stamp}`) as [string, string, string];
const [jobA, jobC] = [`SHR${stamp}-A`, `SHR${stamp}-C`];
const [ownA, ownB] = [`${A}-claude`, `${B}-claude`];
let n = 0;
const account = (id: string, owner_id: string | null, shared = false) => ({
  id,
  owner_id,
  shared,
  provider: "claude" as const,
  kind: "subscription" as const,
  label: id,
  sealed: seal(`secret-of-${id}`, pair.publicKey),
  created_at: new Date(1_700_000_000_000 + n++),
});
const leased = async (job: string) => {
  const got = await accountFor(job, "claude", undefined, key);
  return got && typeof got === "object" ? got.id : got;
};

await db.insert(user).values([A, B, C].map((id) => ({ id, name: `Name ${id}`, email: `${id}@example.com`, role: "engineer" as const })));
await db.insert(jobs).values([linearJob(jobA, jobA, { owner_id: A }), linearJob(jobC, jobC, { owner_id: C })]);
try {
  await db.insert(agentAccounts).values([account(ownA, A), account(ownB, B)]);
  assert.equal(await leased(jobC), null, "C has none, nothing is shared, no pool: blocked");
  assert.equal(await leased(jobA), ownA, "A's job runs on A's own account");

  // Opting in: B's account serves C, never anyone's job ahead of their own account.
  assert.deepEqual(await setAccountShared(db, B, ownB, true), { ok: true });
  assert.equal(await leased(jobC), ownB, "C runs on B's shared account");
  assert.equal(await leased(jobA), ownA, "A still takes A's own account first");
  assert.deepEqual(await setAccountShared(db, A, ownA, true), { ok: true });
  assert.equal(await leased(jobA), ownA, "sharing A's own account does not change A's jobs");
  await setAccountShared(db, A, ownA, false);

  // Opting out: new leases stop, a run already on it keeps it across wakes.
  await db
    .insert(runs)
    .values({ session_id: `${jobC}-s`, job_key: jobC, branch: `hive/${jobC}`, account_id: ownB, started_at: new Date(), last_event_at: new Date() });
  assert.deepEqual(await setAccountShared(db, B, ownB, false), { ok: true });
  assert.equal(await leased(jobC), ownB, "C's running attempt keeps B's account after B opts out");
  await db.update(jobs).set({ attempt: 2 }).where(eq(jobs.key, jobC));
  assert.equal(await leased(jobC), null, "C's next attempt gets no lease on it");

  // Pool accounts and shared ones are both the pool.
  await db.insert(agentAccounts).values(account(`${stamp}-pool`, null));
  assert.equal(await leased(jobC), `${stamp}-pool`, "with no shared account, the team pool's");

  // The toggle: your own account only, one message for someone else's id and for an id that does not exist.
  const refused = { ok: false, status: 403, message: "You can only share your own accounts." };
  assert.deepEqual(await setAccountShared(db, C, ownB, true), refused, "C cannot share B's account");
  assert.deepEqual(await setAccountShared(db, C, "no-such-account", true), refused, "an unknown id gets the same answer");
  assert.equal((await db.select().from(agentAccounts).where(eq(agentAccounts.id, ownB)))[0]!.shared, false, "and nothing changed");

  // The pool list shows shared accounts; only an admin sees whose.
  await setAccountShared(db, B, ownB, true);
  const listed = async (admin: boolean) => (await poolAccounts(db, { id: C, admin })).find((a) => a.id === ownB)?.ownerName;
  assert.equal(await listed(true), `Name ${B}`, "an admin sees who shares it");
  assert.equal(await listed(false), null, "an engineer sees that it is shared, not by whom");
  const seen = (await poolAccounts(db, { id: C, admin: false })).find((a) => a.id === ownB);
  assert.equal(seen?.ownerId, "member", "nor the sharer's user id");
} finally {
  await db.delete(runs).where(inArray(runs.job_key, [jobA, jobC]));
  await db.delete(jobs).where(inArray(jobs.key, [jobA, jobC]));
  await db.delete(agentAccounts).where(eq(agentAccounts.id, `${stamp}-pool`));
  await db.delete(user).where(inArray(user.id, [A, B, C]));
}

console.log("pool share regressions pass");
process.exit(0);
