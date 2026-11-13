import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, linearSettings, user } = await import("../db/schema");
const { linearClient } = await import("../lib/linear");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { factorySchema } = await import("../lib/config");
const { resolveOwner } = await import("../lib/job-owner");
const { claim } = await import("../runner/ops");
const { config } = await import("../runner/config");
const { linearJob } = await import("./fixtures");

const stamp = Date.now();
const prefix = `job-owner-${stamp}`;
const REPO = `${prefix}/repo`;
const uid = (name: string) => `${prefix}-${name}`;
const email = (name: string) => `${prefix}-${name}@example.com`;
const users = ["alice", "bob", "carol", "hive"].map((name) => ({ id: uid(name), name, email: email(name) }));
// Mixed case on purpose: the stored email's case must not matter either.
users.push({ id: uid("mixed"), name: "mixed", email: `Mixed.${prefix}@Example.COM` });

const FACTORY = "factory";
const [savedSettings] = await db.select().from(linearSettings).where(eq(linearSettings.id, FACTORY));
const setHive = (hiveUserId: string | null) =>
  db
    .insert(linearSettings)
    .values({ id: FACTORY, config: { teamKeys: ["OWN"], label: "hive", hiveUserId }, updated_at: new Date(), updated_by: "job-owner-regressions" })
    .onConflictDoUpdate({ target: linearSettings.id, set: { config: { teamKeys: ["OWN"], label: "hive", hiveUserId } } });

const keys = [`OWN${stamp}-1`, `OWN${stamp}-2`];
const maxInFlight = config.factory.maxInFlight;

try {
  await db.insert(user).values(users);
  await setHive(null);

  // resolveOwner
  assert.equal(await resolveOwner(db, { assigneeEmail: email("alice"), creatorEmail: email("bob") }), uid("alice"), "assignee beats creator");
  assert.equal(
    await resolveOwner(db, { assigneeEmail: `nobody-${prefix}@example.com`, creatorEmail: email("bob") }),
    uid("bob"),
    "creator when assignee is not on Hive",
  );
  assert.equal(await resolveOwner(db, { assigneeEmail: `nobody-${prefix}@example.com`, creatorEmail: `none-${prefix}@example.com` }), null, "nobody on Hive");
  assert.equal(await resolveOwner(db, {}), null, "no hints");
  assert.equal(await resolveOwner(db, { assigneeEmail: email("alice").toUpperCase() }), uid("alice"), "lookup case differs from stored");
  assert.equal(await resolveOwner(db, { creatorEmail: `mixed.${prefix}@example.com` }), uid("mixed"), "stored mixed case matches lowercase lookup");

  // R27f: a linked GitHub id matches a private-email owner, and beats another user's email.
  await db
    .update(user)
    .set({ githubId: stamp, githubLogin: "private-dana" })
    .where(eq(user.id, uid("carol")));
  assert.equal(await resolveOwner(db, { assigneeGithubId: stamp, assigneeEmail: null }), uid("carol"), "linked id, no public email");
  assert.equal(await resolveOwner(db, { assigneeGithubId: stamp, assigneeEmail: email("alice") }), uid("carol"), "the linked id before the email");
  assert.equal(await resolveOwner(db, { assigneeGithubId: stamp + 1, assigneeEmail: email("alice") }), uid("alice"), "an unlinked id falls back to email");
  assert.equal(await resolveOwner(db, { assigneeGithubId: stamp + 1, creatorGithubId: stamp }), uid("carol"), "a linked creator when the assignee is not");

  await setHive("lin-hive");
  const hiveHints = { assigneeId: "lin-hive", assigneeEmail: email("hive") };
  assert.equal(await resolveOwner(db, { ...hiveHints, creatorEmail: `none-${prefix}@example.com` }), null, "Hive's Linear user never owns");
  assert.equal(await resolveOwner(db, { ...hiveHints, creatorId: "lin-carol", creatorEmail: email("carol") }), uid("carol"), "falls through to the creator");
  assert.equal(await resolveOwner(db, { assigneeId: "lin-alice", assigneeEmail: email("alice") }), uid("alice"), "other assignees still own");
  await setHive(null);

  // claim()
  type Issue = { id: string; identifier: string; assignee: { id: string; email: string } | null; creator: { id: string; email: string } | null };
  let issues: Issue[] = [];
  const queries: string[] = [];
  const fetchFake = (async (_url: string, init: RequestInit) => {
    const { query } = JSON.parse(String(init.body)) as { query: string };
    queries.push(query);
    assert.ok(query.includes("issues(first: 50"), "only readyIssues is asked");
    const nodes = issues.map((i) => ({
      ...i,
      title: "t",
      url: "u",
      description: null,
      createdAt: "2026-11-01T00:00:00Z",
      state: { name: "Todo", type: "unstarted" },
      labels: { nodes: [{ name: "hive", parent: null }] },
    }));
    return Response.json({ data: { issues: { nodes } } });
  }) as unknown as typeof fetch;
  const client = linearClient("key", { fetch: fetchFake, sleep: async () => {} });
  const adapter = createLinearAdapter(() => ({ client, db, limits: factorySchema.parse({}) }));
  const run = () => claim({ sources: [adapter], repos: async () => [REPO], registry: async () => [] });
  const person = (name: string) => ({ id: `lin-${name}`, email: email(name) });
  const row = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!;
  config.factory.maxInFlight = 100;

  issues = [{ id: `${prefix}-a`, identifier: keys[0]!, assignee: person("alice"), creator: person("bob") }];
  assert.deepEqual((await run()).claimed, [keys[0]]);
  assert.ok(queries[0]!.includes("assignee { id email }") && queries[0]!.includes("creator { id email }"), "readyIssues asks for assignee and creator");
  assert.equal((await row(keys[0]!)).owner_id, uid("alice"), "first claim: the assignee owns the job");

  await db.update(jobs).set({ stage: "failed" }).where(eq(jobs.key, keys[0]!));
  issues = [{ id: `${prefix}-a`, identifier: keys[0]!, assignee: person("carol"), creator: person("bob") }];
  await run();
  const again = await row(keys[0]!);
  assert.equal(again.attempt, 2, "the reclaim is a new attempt");
  assert.equal(again.owner_id, uid("alice"), "and keeps its owner");

  await db.insert(jobs).values(linearJob(`${prefix}-b`, keys[1]!, { repo: REPO, stage: "failed", owner_id: null }));
  issues = [{ id: `${prefix}-b`, identifier: keys[1]!, assignee: person("alice"), creator: null }];
  await run();
  const old = await row(keys[1]!);
  assert.equal(old.attempt, 2, "the old job was reclaimed");
  assert.equal(old.owner_id, null, "an ownerless job is not backfilled");
  console.log("job owner regressions passed");
} finally {
  config.factory.maxInFlight = maxInFlight;
  await db.delete(jobs).where(inArray(jobs.key, keys));
  await db.delete(user).where(
    inArray(
      user.id,
      users.map((u) => u.id),
    ),
  );
  if (savedSettings) await db.update(linearSettings).set({ config: savedSettings.config }).where(eq(linearSettings.id, FACTORY));
  else await db.delete(linearSettings).where(eq(linearSettings.id, FACTORY));
}
process.exit(0);
