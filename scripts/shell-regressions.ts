import "./test-guard";
import assert from "node:assert/strict";
import type { JobRow } from "../db/schema";

// R25b: the sidebar's Working list and counts, the breadcrumb and the small chips are pure rules.
const { crumbsOf, elapsed, harnessChip, repoBadge, sidebarCounts, workingJobs } = await import("../components/panel/shell-model");

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

assert.deepEqual(sidebarCounts(rows, me), { waiting: 1, settled: 2 }, "waiting is the inbox's mine count; settled skips archived jobs");
assert.deepEqual(sidebarCounts(rows, null), { waiting: 0, settled: 2 }, "no viewer has nothing waiting");

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

console.log("shell regressions passed");
