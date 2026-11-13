import "./test-guard";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobEvidence, jobMedia, jobs, machines } = await import("../db/schema");
const { testJobBlocker } = await import("../lib/machine");
const { runTestJob, testJobStatus, TEST_JOB_TITLE } = await import("../lib/settings-test-job");
const { checks, TEST_JOB_REPO, testJobDescription } = await import("../lib/test-job");
const { linearJob } = await import("./fixtures");
type NewJob = Parameters<typeof runTestJob>[0]["newJob"];
type FileDraft = Parameters<NewJob["file"]>[0];

const admin = { email: "admin@example.com", role: "admin", twoFactorEnabled: true, setupDoneAt: new Date() };
const engineer = { email: "engineer@example.com", role: "engineer", twoFactorEnabled: true };
const filed: FileDraft[] = [];
const newJob = (user: unknown): NewJob => ({
  user: async () => user as never,
  file: async (draft) => (filed.push(draft), { key: "FAC-1", url: "https://linear.app/x/issue/FAC-1" }),
  harnesses: async () => null,
  registry: async () => [{ repo: TEST_JOB_REPO, display_name: null, enabled: true, is_default: false }] as never,
});
const run = (user: unknown) => runTestJob({ db, user: async () => user as never, newJob: newJob(user) });

const platform = (ready: boolean) => ({ ready, devices: 1, booted: 1, ...(!ready && { reason: "no simulator" }) });
const inventory = (iosReady = true) => ({
  runnerSha: "a".repeat(40),
  t3: { up: true, version: "1", environmentId: "env" },
  connect: "linked",
  projects: { source: "unknown" },
  repos: [],
  devices: { ios: platform(iosReady), android: platform(true) },
  browser: { answers: true },
});
const now = Date.now();
const mac = (id: string, inv: unknown, seenAgoMs = 0) => ({ id, name: id, last_seen_at: new Date(now - seenAgoMs), heartbeat: {}, inventory: inv });

// (1) admin-only
for (const user of [null, engineer]) {
  const outcome = await run(user);
  assert.equal(outcome.ok, false, `${user?.role ?? "signed out"} cannot run the test job`);
}
assert.equal(filed.length, 0, "and nothing is filed");

// (2) disabled with a reason until an online Mac shows browser, iOS and Android ready
assert.match(testJobBlocker([], now) ?? "", /No online Mac/, "no machine: blocked with the reason");
assert.notEqual(testJobBlocker([mac("old", inventory(), 3_600_000)], now), null, "an offline ready Mac does not count");
assert.notEqual(testJobBlocker([mac("ios", inventory(false))], now), null, "nor one whose iOS is not ready");
assert.notEqual(testJobBlocker([mac("none", null)], now), null, "nor one with no inventory");
const blocked = await run(admin);
assert.match(!blocked.ok ? blocked.message : "", /No online Mac/, "the action refuses with the same reason");
assert.equal(filed.length, 0);
await db.insert(machines).values([mac("mac-ios", inventory(false)), mac("mac-1", inventory())]);
assert.equal(testJobBlocker(await db.select().from(machines), Date.now()), null, "one ready Mac enables it");

// (3) one click files one job through createJob; a second files nothing while it is unsettled
const first = await run(admin);
assert.deepEqual(first, { ok: true, existing: false, key: "FAC-1", href: "https://linear.app/x/issue/FAC-1" });
assert.equal(filed.length, 1, "one job is filed");
assert.equal(filed[0]!.description, testJobDescription("devices", "Settings → Machines"), "with lib/test-job's devices text");
assert.ok(filed[0]!.title.startsWith(TEST_JOB_TITLE), "marked by its title");
assert.deepEqual(filed[0]!.tags, ["review"], "with the review label, so its PR never merges");
assert.deepEqual(
  filed[0]!.labels?.map((l) => l.name),
  ["factory-playground", "Local"],
  "on the canary's repo, run locally",
);
await run(admin);
assert.equal(
  filed[1]!.requestId,
  filed[0]!.requestId,
  "before the runner claims it, a second click replays the same request, so Linear returns the same issue",
);
const firstRequest = filed[0]!.requestId;
filed.length = 0;

await db.insert(jobs).values(
  linearJob("issue-1", "FAC-1", {
    title: `${TEST_JOB_TITLE} 2026-11-14 00:00: unit converter demo page on devices`,
    stage: "implementing",
    session_id: "s-1",
  }),
);
const again = await run(admin);
assert.deepEqual(again, { ok: true, existing: true, key: "FAC-1", href: "/?view=list&run=s-1" }, "once claimed, a second click returns the job");
assert.equal(filed.length, 0, "and files nothing");
await db.delete(machines);
assert.deepEqual(await run(admin), again, "an unsettled job is returned even when no Mac is ready now");
await db.insert(machines).values([mac("mac-ios", inventory(false)), mac("mac-1", inventory())]);
assert.deepEqual(
  (await testJobStatus(db)).last,
  { key: "FAC-1", href: "/?view=list&run=s-1", stage: "implementing", checks: null },
  "no checks before it settles",
);

// (4) a settled job shows lib/test-job's checks
const png = (w: number, h: number, seed: number) =>
  Buffer.from([0x89, 0x50, 0x4e, 0x47, ...Array(12).fill(0), 0, 0, w >> 8, w & 255, 0, 0, h >> 8, h & 255, seed]);
const shots = [
  ["after-browser.png", png(1280, 800, 1)],
  ["after-ios.png", png(390, 844, 2)],
  ["after-android.png", png(412, 915, 3)],
] as const;
const check = { name: "test" as const, command: "bun test", exitCode: 0, startedAt: "2026-11-14T00:00:00Z", durationMs: 1, outputTail: "", passed: true };
const at = new Date();
await db.insert(jobMedia).values(
  shots.map(([file, bytes]) => ({
    stage_event_id: "ev-pr",
    file,
    job_key: "FAC-1",
    content_type: "image/png" as const,
    bytes,
    event_id: "ev-pr",
    recorded_at: at,
  })),
);
await db.insert(jobEvidence).values({
  job_key: "FAC-1",
  sha: "b".repeat(40),
  attempt: 1,
  repo: TEST_JOB_REPO,
  clean: true,
  producer: "agent",
  source: "project.toml",
  checks: [check],
  event_id: "ev-e",
  recorded_at: at,
});
await db
  .update(jobs)
  .set({
    stage: "pr",
    execution: "local",
    machine_id: "mac-1",
    pr_url: "https://github.com/o/r/pull/1",
    assessment_event_id: "ev-pr",
    evidence: { sha: "b".repeat(40), attempt: 1, clean: true, producer: "agent", source: "project.toml", at: at.toISOString(), checks: [check] },
    merge_decision: { outcome: "handover", reasons: ["Has the review label."], headSha: "b".repeat(40) } as never,
  })
  .where(eq(jobs.key, "FAC-1"));
const settled = (await testJobStatus(db)).last;
const [row] = await db.select().from(jobs).where(eq(jobs.key, "FAC-1"));
const expected = checks("devices", row!, { sha: "b".repeat(40), state: "OPEN" }, [], undefined).map((c) => c.name);
assert.deepEqual(
  settled?.checks?.map((c) => c.name),
  expected,
  "the settled job lists lib/test-job's checks",
);
assert.deepEqual(
  settled?.checks?.filter((c) => !c.ok).map((c) => `${c.name}: ${c.detail}`),
  [],
  "read from its row, media and evidence, all passing",
);
await db
  .update(jobs)
  .set({ merge_decision: { outcome: "handover", reasons: [], headSha: "c".repeat(40) } as never })
  .where(eq(jobs.key, "FAC-1"));
assert.ok(
  (await testJobStatus(db)).last?.checks?.some((c) => !c.ok),
  "evidence that passed at an older commit does not count for the PR's head",
);
await db
  .update(jobs)
  .set({ merge_decision: { outcome: "handover", reasons: [], headSha: null } as never })
  .where(eq(jobs.key, "FAC-1"));
assert.ok(
  (await testJobStatus(db)).last?.checks?.some((c) => !c.ok),
  "nor when the decision did not learn the head",
);
const next = await run(admin);
assert.equal(next.ok && !next.existing && filed.length, 1, "after it settles, a click files a new one");
assert.notEqual(filed[0]!.requestId, firstRequest, "under a new request, keyed on the settled job");

console.log("settings test job regressions passed");
process.exit(0);
