import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, user } = await import("../db/schema");
const { linearJob } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { inboxItems, ownedBy, parseOwnerView, viewerOf } = await import("../lib/inbox");
const { dismissJob } = await import("../lib/inbox-actions");

// R8b, Q2, Q3: Mine is my jobs, plus the ownerless ones when I'm an admin; Everyone is all of them; owners only filter.
const stamp = Date.now();
const uid = (name: string) => `views-${stamp}-${name}`;
const member = { twoFactorEnabled: true, setupDoneAt: new Date() };
const alice = { ...member, id: uid("alice"), email: `${uid("alice")}@example.com`, role: "engineer" };
const bob = { ...member, id: uid("bob"), email: `${uid("bob")}@example.com`, role: "engineer" };
const admin = { ...member, id: uid("admin"), email: `${uid("admin")}@example.com`, role: "admin" };
const people = [alice, bob, admin];
const k = (n: number) => `VIEWS${stamp}-${n}`;
const ext = (n: number) => `views-${stamp}-${n}`;
const now = new Date();
const rows = [
  linearJob(ext(1), k(1), { owner_id: alice.id, stage: "waiting", stage_at: now }),
  linearJob(ext(2), k(2), { owner_id: bob.id, stage: "failed", stage_at: now }),
  linearJob(ext(3), k(3), { owner_id: null, stage: "waiting", stage_at: now }),
  linearJob(ext(4), k(4), { owner_id: admin.id, stage: "waiting", stage_at: now }),
];
const keysOf = (list: readonly { key: string }[]) => list.map((j) => j.key).sort();

try {
  await db.insert(user).values(people.map(({ id, email }) => ({ id, email, name: id })));
  await db.insert(jobs).values(rows);
  const all = await db
    .select()
    .from(jobs)
    .where(
      inArray(
        jobs.key,
        rows.map((r) => r.key),
      ),
    );
  assert.equal(all.length, 4);

  // 1.1 A's Mine contains only A's.
  assert.deepEqual(keysOf(ownedBy(all, "mine", viewerOf(alice))), [k(1)], "an engineer's Mine is their own jobs");
  // 1.2 An admin's Mine is their own plus the ownerless ones.
  assert.deepEqual(keysOf(ownedBy(all, "mine", viewerOf(admin))), [k(3), k(4)].sort(), "an admin's Mine adds ownerless jobs");
  // 1.3 Everyone contains all of them, for anyone.
  for (const who of people) assert.deepEqual(keysOf(ownedBy(all, "everyone", viewerOf(who))), keysOf(all), "Everyone is every job");
  // 1.4 Two engineers get different Inbox items from the same jobs (PRD check for R8).
  const inboxOf = (who: typeof alice) => keysOf(inboxItems(ownedBy(all, "mine", viewerOf(who))).map((i) => i.job));
  assert.deepEqual(inboxOf(alice), [k(1)]);
  assert.deepEqual(inboxOf(bob), [k(2)]);
  assert.notDeepEqual(inboxOf(alice), inboxOf(bob));
  assert.deepEqual(ownedBy(all, "mine", viewerOf(null)), [], "no session sees nothing as Mine");
  // The view only comes from these two words.
  assert.equal(parseOwnerView("mine"), "mine");
  assert.equal(parseOwnerView("everyone"), "everyone");
  for (const raw of ["board", "list", "Mine", "", undefined, ["mine"]]) assert.equal(parseOwnerView(raw), undefined, `rejects ${String(raw)}`);

  // 1.5 An engineer can act on someone else's item from Everyone.
  assert.ok(
    inboxItems(ownedBy(all, "everyone", viewerOf(alice))).some((i) => i.job.key === k(2)),
    "bob's failure is in alice's Everyone",
  );
  const outcome = await dismissJob({ db, user: async () => alice, reply: async () => {}, newJob: undefined as never }, jobId("linear", ext(2)));
  assert.equal(outcome.ok, true, "alice may dismiss bob's failed job");
  const [after] = await db
    .select()
    .from(jobs)
    .where(eq(jobs.key, k(2)));
  assert.notEqual(after?.dismissed_at ?? null, null, "the dismissal landed");
} finally {
  await db.delete(jobs).where(
    inArray(
      jobs.key,
      rows.map((r) => r.key),
    ),
  );
  await db.delete(user).where(
    inArray(
      user.id,
      people.map((p) => p.id),
    ),
  );
}

console.log("views regressions passed");
