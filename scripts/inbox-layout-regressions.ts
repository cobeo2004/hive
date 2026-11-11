import "./test-guard";
import assert from "node:assert/strict";
import type { JobRow } from "../db/schema";
import type { InboxKind } from "../lib/inbox";
import type { MergeDecision } from "../lib/merge-decision";

// R25e: each inbox kind renders its own blocks; the badges, the retry label and the Request changes rule are pure.
const { BLOCK_LABEL, canRequestChanges, dangerBlock, inboxBlocks, kindBadge, retryLabel } = await import("../components/panel/inbox-model");

const KINDS: readonly InboxKind[] = ["question", "plan_approval", "revert_failed", "stop_unconfirmed", "handover", "failed"];
const job = (over: Partial<JobRow> = {}) => ({ key: "A-1", attempt: 1, ...over }) as JobRow;
const decision = (over: Partial<MergeDecision> = {}) =>
  ({
    outcome: "merge",
    reasons: [],
    autonomy: "trial",
    evaluatedAt: "2026-11-11T00:00:00.000Z",
    headSha: "h1",
    headSeenAt: null,
    stageEventId: null,
    ...over,
  }) as MergeDecision;
const item = (kind: InboxKind, over: Partial<MergeDecision> = {}) => ({ kind, job: job(), decision: decision(over), at: new Date(0) });

const lists = KINDS.map((kind) => inboxBlocks(kind));
for (const [i, blocks] of lists.entries()) {
  assert.ok(blocks.length > 0, `${KINDS[i]} renders its blocks`);
  for (const block of blocks) assert.equal(typeof BLOCK_LABEL[block], "string", `${block} has a canvas label`);
}
assert.equal(new Set(lists.map((blocks) => blocks.join(","))).size, KINDS.length, "each fixture kind renders its own block");
assert.deepEqual(inboxBlocks("question"), ["asked"]);
assert.deepEqual(inboxBlocks("plan_approval"), ["plan"]);
assert.deepEqual(
  inboxBlocks("handover").filter((block) => block === "evidence" || block === "changes"),
  ["changes", "evidence"],
  "a handover shows its evidence and changed files",
);
for (const kind of ["failed", "revert_failed", "stop_unconfirmed"] as const)
  assert.ok(
    ["reading", "changes"].every((block) => inboxBlocks(kind).includes(block as never)),
    `${kind} still shows the assessment and the review`,
  );

for (const kind of KINDS)
  assert.equal(dangerBlock(kind), kind === "failed" || kind === "revert_failed", `${kind} gets a danger well only when it is a failure`);

assert.equal(retryLabel({ attempt: 1 }), "Retry as attempt 2");
assert.equal(retryLabel({ attempt: 3 }), "Retry as attempt 4", "the label names the attempt the retry starts");

assert.deepEqual(kindBadge(item("handover")), { label: "Would merge", tone: "ready" }, "a PR the factory would merge is the only lime badge (Q66)");
assert.deepEqual(
  kindBadge(item("handover", { outcome: "handover" })),
  { label: "Ready for your review", tone: "testing" },
  "a handover nobody would merge is not lime",
);
assert.equal(kindBadge({ kind: "handover", job: job(), decision: null, at: new Date(0) }).tone, "testing", "a PR the runner has not read yet is not lime");
for (const kind of KINDS.filter((one) => one !== "handover")) assert.notEqual(kindBadge(item(kind)).tone, "ready", `${kind} is never lime (Q66)`);

assert.equal(canRequestChanges("plan_approval", "Plan approved."), false, "the approval text alone would resume as an approval");
assert.equal(canRequestChanges("plan_approval", "  "), false, "Request changes needs text");
assert.equal(canRequestChanges("plan_approval", "Plan approved.\n\nPlan approved."), false);
assert.equal(canRequestChanges("plan_approval", "add tests"), true);
assert.equal(canRequestChanges("handover", "Plan approved."), true, "an ordinary review comment may read like the approval text");

console.log("inbox layout regressions passed");
