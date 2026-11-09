import "./test-guard";
import assert from "node:assert/strict";
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
Object.assign(session, { read: async () => ({ user: { email: OWNER, role: "engineer", twoFactorEnabled: true } }) });
// A run's feeds are read by its session id as a bound parameter, so a Codex id with slashes reads like any other.
const { load, runJob, sessionAgentsQuery, sessionEventsQuery, sessionStagesQuery } = await import("../lib/live-queries");
for (const query of [sessionAgentsQuery(CODEX), sessionEventsQuery(CODEX), sessionStagesQuery(CODEX)]) {
  assert.deepEqual(await load<unknown>(query), { initialData: [] }, `a run feed reads ${CODEX}`);
}
assert.deepEqual(await runJob(CODEX), { jobKey: undefined, jobId: undefined });

console.log("run links regressions passed");
process.exit(0);
