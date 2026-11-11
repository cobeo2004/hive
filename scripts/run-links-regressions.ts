import "./test-guard";
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { jobsHref } from "../components/panel/job-view";
import { activityHref, fullViewHref, parseSessionId } from "../lib/run-links";

const OWNER = "owner@example.com";

const CODEX = "mcp:hive/FAC-61";
for (const id of [CODEX, "mcp:hive/FAC-10-a2", "evidence:hive/FAC-10-a2", "5f0c1e2a-9b7d-4c3e-8a1f-2d6b7c8e9f01", "mcp:hive/FAC-7"]) {
  assert.equal(parseSessionId(id), id, `${id} is a session id`);
}
for (const junk of [undefined, null, "", "/", "mcp:hive/", "/mcp:factory", "mcp:hive//FAC-1", "a b", "a?b", "a#b", "a&b=c", "x".repeat(129)]) {
  assert.equal(parseSessionId(junk), undefined, `${JSON.stringify(junk)} is not a session id`);
}

assert.equal(activityHref(CODEX), "/activity?run=mcp%3Ahive%2FFAC-61");
assert.equal(new URL(activityHref(CODEX), "http://x").searchParams.get("run"), CODEX, "the activity link round-trips the id");
assert.equal(new URL(jobsHref("list", CODEX), "http://x").searchParams.get("run"), CODEX, "the jobs link round-trips the id");
const opened = new URL(jobsHref("board", CODEX), "http://x");
const full = new URL(fullViewHref(opened.pathname, opened.searchParams, true), "http://x");
assert.equal(full.searchParams.get("full"), "1", "full view is a search param");
assert.equal(full.searchParams.get("run"), CODEX, "full view keeps the open run");
assert.equal(full.searchParams.get("view"), "board", "full view keeps the jobs layout");
const back = new URL(fullViewHref(full.pathname, full.searchParams, false), "http://x");
assert.equal(back.searchParams.has("full"), false, "the side panel drops the param");
assert.equal(back.searchParams.get("run"), CODEX, "the side panel keeps the open run");
assert.equal(fullViewHref("/inbox", new URLSearchParams({ job: "FAC-1" }), true), "/inbox?job=FAC-1&full=1");
assert.equal(fullViewHref("/inbox", new URLSearchParams({ full: "1" }), false), "/inbox", "no empty query is left behind");
const { session } = await import("../lib/auth/server");
Object.assign(session, { read: async () => ({ user: { email: OWNER, role: "engineer", twoFactorEnabled: true, setupDoneAt: new Date() } }) });
// A run's feeds are read by its session id as a bound parameter, so a Codex id with slashes reads like any other.
const { load, runJob, sessionAgentsQuery, sessionEventsQuery, sessionStagesQuery } = await import("../lib/live-queries");
for (const query of [sessionAgentsQuery(CODEX), sessionEventsQuery(CODEX), sessionStagesQuery(CODEX)]) {
  assert.deepEqual(await load<unknown>(query), { initialData: [] }, `a run feed reads ${CODEX}`);
}
assert.deepEqual(await runJob(CODEX), { jobKey: undefined, jobId: undefined });

// --- Run detail (R25d): what shows where, and who may message the thread
const { canMessageThread } = await import("../components/panel/message-thread");
const { mediaPhase } = await import("../components/panel/evidence");
const { RunDetail } = await import("../components/panel/run-detail");
const T = new Date(1_800_000_000_000);
const SHA = "a".repeat(40);
const D = { outcome: "handover", reasons: [], autonomy: "auto", evaluatedAt: T.toISOString(), headSha: SHA, headSeenAt: null, stageEventId: null };
const REVERT = {
  ...D,
  merged: { sha: "m", method: "squash", at: T.toISOString(), base: "main", title: "t", commits: 1 },
  watch: { state: "revert_failed", until: T.toISOString(), failed: ["ci"], revertPr: null, reason: "x" },
};
const media = [
  { file: "before-a.png", caption: "was" },
  { file: "after-a.png", caption: "now" },
];
const assessment = { recommendation: "merge", interpretation: "Read it", assumptions: [], confidence: { confident: true }, media };
const job = (over: object) =>
  ({
    id: "linear:FAC-1",
    source: "linear",
    key: "FAC-1",
    url: "https://x/FAC-1",
    title: "Fix it",
    stage: "implementing",
    stage_at: T,
    updated_at: T,
    dismissed_at: null,
    archived_at: null,
    attempt: 1,
    assessment_event_id: "ev1",
    ...over,
  }) as never;
const running = job({ t3_thread_id: "th1", merge_decision: D, merge_assessment: assessment });
const handover = job({ stage: "pr", pr_url: "https://x/pr/1", merge_decision: D });
const reverted = job({ stage: "merged", merge_decision: REVERT });
assert.equal(canMessageThread(running), false, "a running job has no message box");
assert.equal(canMessageThread(handover), false, "a handover is answered by approve, changes or close, not a follow-up");
assert.equal(canMessageThread(reverted), true, "a failed revert can file a follow-up");
assert.equal(canMessageThread(job({ stage: "merged", merge_decision: REVERT, dismissed_at: new Date(T.getTime() + 1) })), false, "a dismissed one is gone");
for (const [file, phase] of Object.entries({ "before-home.png": "before", "after-x.mp4": "after", "shot.png": null, "xbefore-1.png": null }))
  assert.equal(mediaPhase(file), phase, file);
const feed = (...rows: object[]) => ({ initialData: rows as never[] });
const stage = { eventId: "e1", sessionId: "s1", at: T.getTime(), kind: "stage", stage: "implementing", summary: "Working" };
const agent = {
  tool_use_id: "t1",
  role: "implement",
  harness: "claude",
  model: "m",
  status: "completed",
  started_at: T,
  ended_at: new Date(T.getTime() + 30_000),
};
const evidence = { job_key: "FAC-1", sha: SHA, attempt: 1, clean: true, producer: "runner", source: "package", checks: [], recorded_at: T };
const audit = { id: "au1", action: "merge_requested", result: "ok", head_sha: SHA, at: T, actor: OWNER, detail: null };
const run = { session_id: "s1", job_key: "FAC-1", status: "active", stage: "implementing", model: "m", t3_thread_id: "th1" } as never;
const render = (j: never, full: boolean) =>
  renderToStaticMarkup(
    createElement(RunDetail, {
      run,
      job: j,
      closeHref: "/x",
      harnesses: [],
      jobSpend: undefined,
      machine: undefined,
      fullView: { full, toggleHref: "/x" },
      audit: feed(audit),
      frame: feed({ taken_at: T }),
      agents: feed(agent),
      evidence: feed(evidence),
      events: feed({ event_id: "e0", at: T, kind: "stage", payload: stage, refusal: null }),
      stages: feed({ event_id: "e1", at: T, kind: "stage", payload: stage, refusal: null }),
    }),
  );
const view = render(running, true);
const shown = ["Live", "Evidence", "Timeline", "Lineage", "Merge decision", "Audit log", "The agent&#x27;s device screen", "Before", "After", "factory-verify"];
for (const text of shown) assert.ok(view.includes(text), `the run detail shows ${text}`);
assert.ok(!view.includes("Message the thread"), "a running job gets no message box");
assert.ok(render(reverted, false).includes("Message the thread"), "a failed revert gets the message box");
assert.ok(!render(handover, false).includes("Message the thread"), "a handover gets none");
assert.doesNotMatch(render(reverted, false).match(/<textarea[^>]*>/)?.[0] ?? "disabled", /disabled/, "an idle message box is editable");
for (const html of [view, render(reverted, false), render(handover, false)]) assert.doesNotMatch(html, /take over|switch to android|\btap\b/i);

console.log("run links regressions passed");
process.exit(0);
