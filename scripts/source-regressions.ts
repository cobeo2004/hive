import "./test-guard";
import assert from "node:assert/strict";
import { asc, eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, linearOptIns, linearSettings, user } = await import("../db/schema");
const ops = await import("../runner/ops");
const { jobId, parseJobs, SOURCES } = await import("../lib/sources");
const { linearJob } = await import("./fixtures");
const { createLinearAdapter, pickedUp } = await import("../lib/sources/linear");
const { factorySchema, TEST_MACHINE_ID } = await import("../lib/config");

const calls: unknown[] = [];
const record =
  <T>(name: string, result: T) =>
  (...args: unknown[]) => {
    calls.push([name, ...args]);
    return Promise.resolve(result);
  };
const team = { id: "T1", states: ["Todo", "In Progress", "In Review", "Done"].map((name) => ({ id: `S:${name}`, name, type: "x" })) };
const node = (id: string, identifier: string) => ({
  id,
  identifier,
  title: `title ${identifier}`,
  url: `https://linear.app/${identifier}`,
  description: "d",
  createdAt: "2026-10-24T00:00:00Z",
  state: { name: "Todo", type: "unstarted" },
  labels: { nodes: [{ name: "hive" }, { name: "bug" }] },
});
let readyNodes: unknown[] = [];
let thread = { state: { name: "In Progress", type: "started" }, labels: ["hive"] };
const labelsById: Record<string, string[]> = { "src-q2": ["hive", "factory-failed"] };
const fakeClient = {
  team: record("team", team),
  update: record("update", undefined),
  comment: record("comment", true),
  labelId: (teamId: string, name: string) => {
    calls.push(["labelId", teamId, name]);
    return Promise.resolve(`label:${name}`);
  },
  readyIssues: (...args: unknown[]) => {
    calls.push(["readyIssues", ...args]);
    return Promise.resolve(readyNodes);
  },
  issueWithComments: (id: string) => {
    calls.push(["issueWithComments", id]);
    return Promise.resolve({ state: thread.state, comments: [] });
  },
  labelsOf: (id: string) => {
    calls.push(["labelsOf", id]);
    return Promise.resolve((labelsById[id] ?? thread.labels).map((name) => ({ id: `label:${name}`, name })));
  },
  setState: record("setState", undefined),
  issuesByIds: (ids: string[]) =>
    Promise.resolve(ids.map((id) => ({ id, archivedAt: null, trashed: null, state: { type: "started", name: "In Progress" }, labels: { nodes: [] } }))),
};
SOURCES.linear = createLinearAdapter(() => ({ client: fakeClient as never, db, limits: factorySchema.parse({}) }));

const EXPECTED = {
  writes: {
    synced: ["SRC-1:pr", "SRC-2:waiting", "SRC-3:failed", "SRC-4:merged"],
    calls: [
      ["team", "SRC"],
      [
        "update",
        "src-pr",
        {
          stateId: "S:In Review",
        },
      ],
      ["comment", "src-pr", "368968ca-5f44-4b9f-8953-4b89e8bcd24c", "Hive has a pull request ready for review: https://g/pr/1\n\ndone"],
      ["comment", "src-wait", "4ac8711f-b5ac-4093-b778-86a8e21f9bab", "Hive stopped and needs an answer before it can continue:\n\nWhich layout?"],
      ["labelsOf", "src-fail"],
      ["labelId", "T1", "factory-failed"],
      [
        "update",
        "src-fail",
        {
          stateId: "S:Todo",
          addedLabelIds: ["label:factory-failed"],
          removedLabelIds: ["label:hive"],
        },
      ],
      ["comment", "src-fail", "b1e0641a-e8ae-43b6-a329-344171e78538", "Hive gave up on this issue (attempt 2): boom\n\nAdd the `hive` label again to retry."],
      [
        "update",
        "src-merged",
        {
          stateId: "S:Done",
        },
      ],
      [
        "update",
        "src-q1",
        {
          stateId: "S:In Progress",
        },
      ],
      ["comment", "src-q1", "e859071b-d221-4990-bacb-cdf002be4667", "Picked up by Hive."],
      ["labelsOf", "src-q2"],
      [
        "update",
        "src-q2",
        {
          stateId: "S:In Progress",
          addedLabelIds: [],
          removedLabelIds: ["label:factory-failed"],
        },
      ],
      ["comment", "src-q2", "fbadf7f5-f936-4d2c-ab88-0d811cc8d183", "Picked up by Hive again (attempt 2, branch hive/SRC-7-a2)."],
    ],
    rows: [
      {
        key: "SRC-1",
        stage: "pr",
        attempt: 1,
        state: "In Review",
        synced_event_id: "e-pr",
        labels: [],
        previous_failure: null,
        comments: 1,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-2",
        stage: "waiting",
        attempt: 1,
        state: null,
        synced_event_id: "e-wait",
        labels: [],
        previous_failure: null,
        comments: 1,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-3",
        stage: "failed",
        attempt: 2,
        state: "Todo",
        synced_event_id: "e-fail",
        labels: [],
        previous_failure: null,
        comments: 1,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-4",
        stage: "merged",
        attempt: 1,
        state: "Done",
        synced_event_id: "e-merged",
        labels: [],
        previous_failure: null,
        comments: 0,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-5",
        stage: "triage",
        attempt: 1,
        state: null,
        synced_event_id: "e-triage",
        labels: [],
        previous_failure: null,
        comments: 0,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-6",
        stage: "queued",
        attempt: 1,
        state: "In Progress",
        synced_event_id: null,
        labels: [],
        previous_failure: null,
        comments: 1,
        repo: "ski043/factory-demo",
      },
      {
        key: "SRC-7",
        stage: "queued",
        attempt: 2,
        state: "In Progress",
        synced_event_id: null,
        labels: [],
        previous_failure: null,
        comments: 1,
        repo: "ski043/factory-demo",
      },
    ],
  },
  claim: {
    claimed: {
      claimed: ["SRC-8", "SRC-9"],
      inFlight: 2,
    },
    calls: [["readyIssues", { teamKeys: ["FAC"], label: "hive", hiveUserId: null, emails: [] }]],
    rows: [
      {
        key: "SRC-8",
        stage: "queued",
        attempt: 1,
        state: "Todo",
        synced_event_id: null,
        labels: ["hive", "bug"],
        previous_failure: null,
        comments: 0,
        repo: "test-owner/claimed-repo",
      },
      {
        key: "SRC-9",
        stage: "queued",
        attempt: 2,
        state: "Todo",
        synced_event_id: null,
        labels: ["hive", "bug"],
        previous_failure: "earlier failure",
        comments: 0,
        repo: "test-owner/claimed-repo",
      },
    ],
  },
  stopCheck: {
    stillLabeled: "still labeled",
    calls: [
      ["issueWithComments", "src-new"],
      ["labelsOf", "src-new"],
    ],
  },
  confirm: {
    unlabeled: {
      stop: true,
      reopen: true,
    },
    canceled: {
      stop: true,
      reopen: false,
    },
    deleted: {
      stop: true,
      reopen: false,
    },
    calls: [
      ["issueWithComments", "src-new"],
      ["labelsOf", "src-new"],
      ["issueWithComments", "src-new"],
      ["labelsOf", "src-new"],
      ["setState", "src-new", "S:Todo"],
    ],
  },
};

const snapshot = async () =>
  parseJobs(await db.select().from(jobs).orderBy(asc(jobs.key))).map((j) => ({
    key: j.key,
    stage: j.stage,
    attempt: j.attempt,
    state: "state" in j.source_state ? j.source_state.state : null,
    synced_event_id: j.synced_event_id,
    labels: j.source_state.labels,
    previous_failure: j.previous_failure,
    comments: j.source_state.factoryCommentIds.length,
    repo: j.repo,
  }));

try {
  await db.delete(linearSettings); // no saved row, so the env defaults decide
  await db.delete(linearOptIns);
  await db.delete(jobs);
  await db
    .insert(jobs)
    .values(
      [
        linearJob("src-pr", "SRC-1", { stage: "pr", stage_event_id: "e-pr", pr_url: "https://g/pr/1", stage_summary: "done" }),
        linearJob("src-wait", "SRC-2", { stage: "waiting", stage_event_id: "e-wait", question: "Which layout?" }),
        linearJob("src-fail", "SRC-3", { stage: "failed", attempt: 2, stage_event_id: "e-fail", stage_summary: "boom" }),
        linearJob("src-merged", "SRC-4", { stage: "merged", stage_event_id: "e-merged" }),
        linearJob("src-triage", "SRC-5", { stage: "triage", stage_event_id: "e-triage" }),
        linearJob("src-q1", "SRC-6", { stage: "queued", state: "Todo" }),
        linearJob("src-q2", "SRC-7", { stage: "queued", attempt: 2, state: "Todo" }),
      ].map((row) => ({ ...row, machine_id: TEST_MACHINE_ID })),
    );
  const { synced } = await ops.writeBack();
  await ops.announceClaims();
  const writes = { synced, calls: structuredClone(calls), rows: await snapshot() };
  calls.length = 0;
  assert.deepEqual((await ops.writeBack()).synced, [], "a second pass writes nothing back");
  assert.deepEqual(calls, [], "and sends nothing to Linear");

  await db.delete(jobs);
  await db
    .insert(jobs)
    .values(linearJob("src-retry", "SRC-9", { stage: "failed", stage_summary: "earlier failure", stage_event_id: "e-r", synced_event_id: "e-r" }));
  readyNodes = [node("src-new", "SRC-8"), node("src-retry", "SRC-9")];
  calls.length = 0;
  const claimed = await ops.claim({ repos: async () => ["test-owner/claimed-repo"], registry: async () => [] });
  const claim = { claimed, calls: structuredClone(calls), rows: await snapshot() };

  calls.length = 0;
  const stillLabeled = await ops.stopJob(jobId("linear", "src-new"), "the factory label was removed in Linear");
  const stopCheck = { stillLabeled, calls: structuredClone(calls) };

  calls.length = 0;
  const adapter = SOURCES.linear;
  thread = { state: { name: "In Progress", type: "started" }, labels: [] };
  const unlabeled = await adapter.confirmStop("src-new", "the factory label was removed in Linear");
  thread = { state: { name: "Canceled", type: "canceled" }, labels: ["Factory"] };
  const canceled = await adapter.confirmStop("src-new", "issue moved to Canceled in Linear");
  const deleted = await adapter.confirmStop("src-new", "the issue was deleted in Linear");
  await adapter.reopen({ key: "SRC-8", writeback: { kind: "linear", issueId: "src-new" } } as never);
  const confirm = { unlabeled, canceled, deleted, calls: structuredClone(calls) };

  assert.deepEqual({ writes, claim, stopCheck, confirm }, EXPECTED);

  // R7b: three pickup triggers over the saved teams and label.
  const pick = (id: string, identifier: string, over: { labels?: string[]; assignee?: { id: string; email?: string } } = {}) => ({
    ...node(id, identifier),
    labels: { nodes: (over.labels ?? []).map((name) => ({ name })) },
    assignee: over.assignee,
  });
  const claimed1 = async (nodes: unknown[]) => {
    readyNodes = nodes;
    return (await ops.claim({ repos: async () => ["test-owner/claimed-repo"], registry: async () => [] })).claimed;
  };
  await db.delete(jobs);
  await db.insert(linearSettings).values({
    id: "factory",
    config: { teamKeys: ["FAC", "MOB"], label: "foo", hiveUserId: "lin-hive" },
    updated_by: "regress",
    updated_at: new Date(),
  });
  const people = [
    { id: "pick-eve", name: "Eve", email: "Pick-Eve@X.com", assigned: true }, // stored in mixed case: matching ignores it
    { id: "pick-dan", name: "Dan", email: "pick-dan@x.com", assigned: false },
  ];
  await db.insert(user).values(people.map(({ id, name, email }) => ({ id, name, email })));
  await db.insert(linearOptIns).values(people.map(({ id, assigned }) => ({ user_id: id, assigned, updated_at: new Date() })));
  const eve = { id: "lin-eve", email: "pick-eve@x.com" };

  calls.length = 0;
  assert.deepEqual(await claimed1([pick("p21", "FAC-21", { labels: ["foo"] })]), ["FAC-21"], "label alone: one job");
  assert.deepEqual(
    calls,
    [["readyIssues", { teamKeys: ["FAC", "MOB"], label: "foo", hiveUserId: "lin-hive", emails: ["pick-eve@x.com"] }]],
    "poll asks only the saved teams",
  );
  assert.deepEqual(await claimed1([pick("p22", "FAC-22", { assignee: { id: "lin-hive" } })]), ["FAC-22"], "assigned to Hive, no label: one job");
  assert.deepEqual(await claimed1([pick("p23", "FAC-23", { assignee: eve })]), ["FAC-23"], "opted-in assignee, no label: one job");
  const dan = pick("p24", "FAC-24", { assignee: { id: "lin-dan", email: "pick-dan@x.com" } });
  assert.deepEqual(await claimed1([dan]), [], "assignee not opted in: no job");
  assert.equal((await db.select().from(jobs)).filter((j) => j.key === "FAC-24").length, 0, "and no row");
  const both = pick("p25", "FAC-25", { labels: ["foo"], assignee: { id: "lin-hive" } });
  assert.deepEqual(await claimed1([both]), ["FAC-25"], "label and assignee: one job");
  await claimed1([both]);
  const rows25 = (await db.select().from(jobs)).filter((j) => j.key === "FAC-25");
  assert.deepEqual(
    rows25.map((j) => j.attempt),
    [1],
    "and a second claim adds none",
  );
  assert.equal(
    pickedUp({ labels: [], assignee: { id: "lin-hive" } }, { label: "foo", hiveUserId: null }, new Set()),
    false,
    "hiveUserId null: Hive trigger off",
  );

  // A failed job comes back only when the pickup label is put back, not by its assignee.
  assert.equal(
    pickedUp({ labels: [{ name: "Factory-Failed" }], assignee: { id: "lin-eve" } }, { label: "foo", hiveUserId: "lin-hive" }, null),
    false,
    "webhook wake: assignee plus factory-failed is not a pick",
  );
  await db.delete(jobs);
  await db.insert(jobs).values({ ...linearJob("p31", "FAC-31", { stage: "failed", attempt: 1 }), machine_id: TEST_MACHINE_ID });
  const failedPick = (labels: string[]) => pick("p31", "FAC-31", { labels, assignee: { id: "lin-hive" } });
  const attemptOf31 = async () => (await db.select().from(jobs).where(eq(jobs.key, "FAC-31")))[0]!.attempt;
  assert.deepEqual(await claimed1([failedPick(["factory-failed"])]), [], "failed assignee-picked job is not reclaimed");
  assert.equal(await attemptOf31(), 1, "and its attempt stays 1");
  assert.deepEqual(await claimed1([failedPick(["foo", "factory-failed"])]), ["FAC-31"], "re-adding the pickup label retries it");
  assert.equal(await attemptOf31(), 2, "as attempt 2");

  // Label removal stop is not undone by the assignee trigger.
  await db.delete(jobs);
  const p99 = (labels: string[]) => pick("p99", "FAC-99", { labels, assignee: { id: "lin-hive" } });
  const row99 = async () => (await db.select().from(jobs).where(eq(jobs.key, "FAC-99")))[0]!;
  assert.deepEqual(await claimed1([p99(["foo"])]), ["FAC-99"]);
  thread = { state: { name: "In Progress", type: "started" }, labels: [] };
  ops.ingestClient.post = async () => ({ refused: [] });
  assert.equal(await ops.stopJob(jobId("linear", "p99"), "the foo label was removed in Linear"), "stopped");
  assert.deepEqual(await claimed1([p99([])]), [], "label removal stop is not undone by the assignee trigger");
  assert.deepEqual([(await row99()).stage, (await row99()).attempt], ["failed", 1]);
  assert.deepEqual(await claimed1([p99(["foo"])]), ["FAC-99"], "re-adding the label retries it");
  assert.equal((await row99()).attempt, 2);

  // The label stops only a job the label picked; unassigning never stops.
  await db.delete(jobs);
  const picked = (labels: string[]) => ({ source_state: { state: null, labels, factoryCommentIds: [] } });
  await db.insert(jobs).values([linearJob("p21", "FAC-21", picked(["foo"])), linearJob("p22", "FAC-22", picked([]))]);
  thread = { state: { name: "In Progress", type: "started" }, labels: [] };
  assert.deepEqual(
    await adapter.confirmStop("p21", "the foo label was removed in Linear"),
    { stop: true, reopen: true },
    "label removed stops a label-picked job",
  );
  assert.deepEqual(
    await adapter.confirmStop("p22", "the foo label was removed in Linear"),
    { stop: false },
    "assignee-picked job is not stopped for a missing label",
  );
  const open = [
    { external_id: "p21", source_state: { labels: ["foo"] } },
    { external_id: "p22", source_state: { labels: [] } },
  ];
  assert.deepEqual(
    (await adapter.stopWanted(open as never)).map((w) => w.job.external_id),
    ["p21"],
    "stopWanted skips the label rule for an assignee pick",
  );

  // The saved team and label reach announce, write-back and requeue; a MOB issue never asks for FAC.
  await db.delete(jobs);
  assert.deepEqual(await claimed1([pick("mob-7", "MOB-7", { labels: ["foo"] })]), ["MOB-7"]);
  await db.update(jobs).set({ machine_id: TEST_MACHINE_ID }).where(eq(jobs.key, "MOB-7"));
  calls.length = 0;
  await ops.announceClaims();
  assert.deepEqual(calls[0], ["team", "MOB"], "a MOB issue is announced against team MOB");
  assert.ok(!calls.some((c) => (c as unknown[])[1] === "FAC"), "and never FAC");
  assert.deepEqual(calls[1], ["update", "mob-7", { stateId: "S:In Progress" }]);
  await db.update(jobs).set({ stage: "failed", stage_event_id: "e-mob", stage_summary: "boom" }).where(eq(jobs.key, "MOB-7"));
  labelsById["mob-7"] = ["foo"];
  calls.length = 0;
  await ops.writeBack();
  const callOf = (name: string) => (calls as unknown[][]).find((c) => c[0] === name)!;
  const update = callOf("update");
  assert.deepEqual(
    update[2],
    { stateId: "S:Todo", addedLabelIds: ["label:factory-failed"], removedLabelIds: ["label:foo"] },
    "write-back on failed removes the saved label",
  );
  assert.ok((callOf("comment")[3] as string).endsWith("Add the `foo` label again to retry."));
  labelsById["mob-7"] = [];
  calls.length = 0;
  await adapter.requeue({ key: "MOB-7", writeback: { kind: "linear", issueId: "mob-7" } } as never);
  assert.ok(
    calls.some((c) => JSON.stringify(c) === JSON.stringify(["labelId", "T1", "foo"])),
    "requeue adds the saved label",
  );
  console.log("source regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs);
  await db.delete(linearSettings);
  await db.delete(user).where(inArray(user.id, ["pick-eve", "pick-dan"]));
  process.exit(process.exitCode ?? 0);
}
