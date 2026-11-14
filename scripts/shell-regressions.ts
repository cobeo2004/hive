import "./test-guard";
import assert from "node:assert/strict";
import type { JobRow } from "../db/schema";

// R25b: the sidebar's Working list and counts, the breadcrumb and the small chips are pure rules.
const { crumbsOf, elapsed, harnessChip, isCurrent, repoBadge, settledJobs, waitingJobs, wikiHref, workflowHref, workingJobs } = await import(
  "../components/panel/shell-model"
);

const T = (minutes: number) => new Date(1_800_000_000_000 + minutes * 60_000);
const job = (key: string, over: Partial<JobRow>) =>
  ({
    key,
    stage: "implementing",
    stage_at: T(0),
    updated_at: T(0),
    claimed_at: T(0),
    archived_at: null,
    stop: null,
    dismissed_at: null,
    owner_id: null,
    ...over,
  }) as JobRow;
const me = { id: "me", admin: false };

const rows = [
  job("A-1", { stage: "implementing", claimed_at: T(1) }),
  job("A-2", { stage: "pr", claimed_at: T(5) }),
  job("A-3", { stage: "queued" }),
  job("A-4", { stage: "waiting", question: "which one?", owner_id: "me" }),
  job("A-5", { stage: "merged" }),
  job("A-6", { stage: "merged", archived_at: T(1) }),
  job("A-7", { stage: "failed", dismissed_at: T(1) }),
];
assert.deepEqual(
  workingJobs(rows).map((j) => j.key),
  ["A-2", "A-1"],
  "running jobs only, most recently claimed first",
);
const moved = [...rows, job("A-8", { stage: "queued", claimed_at: T(9) })];
assert.equal(workingJobs(moved).length, 2);
moved[moved.length - 1] = job("A-8", { stage: "implementing", claimed_at: T(9) });
assert.deepEqual(
  workingJobs(moved).map((j) => j.key),
  ["A-8", "A-2", "A-1"],
  "a job that moves to implementing appears at once",
);

// The sidebar's dropdowns show these lists, and their counts are the lists' lengths.
const keys = (jobs: readonly JobRow[]) => jobs.map((j) => j.key);
const shared = [
  ...rows,
  job("A-9", { stage: "waiting", question: "theirs?", owner_id: "someone-else" }),
  job("A-10", { stage: "failed", stage_at: T(3), owner_id: "someone-else" }),
];
assert.deepEqual(keys(waitingJobs(shared, me)), ["A-4"], "waiting is only the viewer's own inbox items");
assert.deepEqual(keys(waitingJobs(shared, { id: "someone-else", admin: false })), ["A-9", "A-10"], "and another viewer sees theirs");
assert.deepEqual(keys(waitingJobs(shared, null)), [], "no viewer has nothing waiting");
assert.deepEqual(keys(settledJobs(shared)), ["A-10", "A-5", "A-7"], "settled is every finished job, newest first, archived ones left out");
assert.ok(!keys(settledJobs(shared)).includes("A-6"), "the archived merge is not settled");

assert.deepEqual(crumbsOf("/"), ["Unibuz", "Jobs"]);
assert.deepEqual(crumbsOf("/inbox"), ["Unibuz", "Inbox"]);
assert.deepEqual(crumbsOf("/settings/linear"), ["Unibuz", "Settings", "Linear"]);
assert.deepEqual(crumbsOf("/activity"), ["Unibuz", "Other activity"]);
assert.deepEqual(crumbsOf("/repositories/unibuz%2Fapi"), ["Unibuz", "Repositories", "Unibuz/api"], "other segments are decoded");

assert.equal(repoBadge("unibuz/unibuz-mobile").mark, "MO");
assert.equal(repoBadge("unibuz/unibuz-api").mark, "AP");
assert.equal(repoBadge("unibuz/unibuz-mobile").name, "unibuz-mobile");
assert.equal(repoBadge("unibuz/unibuz-mobile").tone, repoBadge("other/unibuz-mobile").tone, "the tone follows the name");

assert.equal(harnessChip("claudeAgent"), "CC");
assert.equal(harnessChip("codex"), "CX");
assert.equal(harnessChip(null), null);

assert.equal(elapsed(30e3), "<1m");
assert.equal(elapsed(18 * 60e3), "18m");
assert.equal(elapsed(3 * 3600e3), "3h");
assert.equal(elapsed(2 * 86400e3), "2d");

// The Repositories section links each repo's pages and marks the one shown, encoded segment or not.
assert.equal(workflowHref("cobeo2004/hive"), "/repositories/cobeo2004%2Fhive/workflow");
assert.equal(wikiHref("cobeo2004/hive"), "/repositories/cobeo2004%2Fhive/wiki");
assert.ok(isCurrent(wikiHref("cobeo2004/hive"), "/repositories/cobeo2004%2Fhive/wiki"));
assert.ok(isCurrent(wikiHref("cobeo2004/hive"), "/repositories/cobeo2004/hive/wiki"));
assert.ok(!isCurrent(wikiHref("cobeo2004/hive"), "/repositories/cobeo2004%2Fhive/workflow"));
assert.ok(!isCurrent(wikiHref("cobeo2004/hive"), "/repositories/cobeo2004%2Fhive-web/wiki"));

console.log("shell regressions passed");
