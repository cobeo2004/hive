import "./test-guard";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, like } from "drizzle-orm";
import type { ExecOptions } from "../lib/exec";
import type { JobHost } from "../lib/host";
import type { PlanGate } from "../lib/plan-gate";
import type { LaunchPlan } from "../runner/overrides";

const { db } = await import("../db/client");
const { agentAccounts, jobs, linearOptIns, repoSettings, repoSstackConfig, runs: runRows, user } = await import("../db/schema");
const { explicitGate, launchEnv, planGate } = await import("../lib/plan-gate");
const { bindThread, claimLaunch, config, deliverStops, pendingLaunches, reconcileStops, releaseLaunch, threads, watchdog } = await import("../runner/ops");
const { newKeyPair, RATE_LIMITED, seal } = await import("../lib/creds");
const { rateLimitRuntime } = await import("../runner/account-usage");
const { transcriptRateLimited } = await import("../lib/transcript");
const { parseRollout } = await import("../lib/codex-usage");
const { relaunchRateLimited } = await import("../runner/inbox");
const { inferUntracked } = await import("../runner/untracked");
const { ingestClient } = await import("../runner/ingest-client");
const { ingest } = await import("../lib/ingest");
const { eventSchema } = await import("../lib/events");
const { runnerEventId } = await import("../lib/stages");
const { github } = await import("../lib/github/pulls");
const { pinnedVersions } = await import("../lib/sandbox");
const { sandboxHarness, sandboxRuntime } = await import("../runner/sandbox");
const { jobId, sourceFor } = await import("../lib/sources");
const { linearJob } = await import("./fixtures");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { factorySchema, TEST_MACHINE_ID } = await import("../lib/config");
const { canReclaim, canReclaimSql, stopDeliverable, stopDeliverableSql } = await import("../runner/binding");
const { and, sql } = await import("drizzle-orm");
const { launchEntries, maybeStarted, MaybeStartedError, mobileRepos, parseThreadId, placeMobile, startLead, startThread } = await import("../runner/launch");
const { launchInSandboxes, NO_ACCOUNT } = await import("../runner/launch");
const { LOCAL_CONFIG, startUnattended, unattendedConfig } = await import("../runner/unattended");
const { isMobileSnapshot } = await import("../lib/execution");
const { hosts, localHost } = await import("../lib/host");
const { everyAtMost, serialQueue } = await import("../runner/queue");
const { recheckScheduler } = await import("../runner/recheck");

assert.equal(planGate({ optIn: true, explicit: undefined, autonomy: "auto" }), "inbox");
assert.equal(planGate({ optIn: false, explicit: "auto", autonomy: "trial" }), "auto");
assert.equal(planGate({ optIn: false, explicit: undefined, autonomy: "trial" }), "inbox");
assert.equal(planGate({ optIn: false, explicit: undefined, autonomy: "off" }), "inbox");
assert.equal(planGate({ optIn: false, explicit: undefined, autonomy: "auto" }), "auto");
assert.equal(planGate({ optIn: false, explicit: "bogus", autonomy: "auto" }), "auto");
assert.equal(explicitGate({ ".sstack/config.toml": '[unattended]\nplan_gate = "inbox"' }), "inbox");
assert.equal(explicitGate({ ".sstack/config.toml": '[unattended]\nplan_gate = "bogus"' }), undefined);
assert.equal(explicitGate({ ".sstack/config.toml": "[invalid" }), undefined);
assert.equal(explicitGate({}), undefined);

const gateUser = `plan-gate-${Date.now()}`;
const gateRepo = `${gateUser}/repo`;
try {
  await db.insert(user).values({ id: gateUser, name: gateUser, email: `${gateUser}@example.com` });
  await db.insert(linearOptIns).values({ user_id: gateUser, plan_approval: true, updated_at: new Date() });
  await db.insert(repoSstackConfig).values({
    repo: gateRepo,
    files: { ".sstack/config.toml": '[unattended]\nplan_gate = "auto"\n' },
    sha: "test",
    read_at: new Date(),
  });
  assert.deepEqual(await launchEnv(gateUser, gateRepo, "auto"), { SSTACK_UNATTENDED: "1", SSTACK_PLAN_GATE: "inbox" });
  assert.deepEqual(await launchEnv(null, gateRepo, "trial"), { SSTACK_UNATTENDED: "1", SSTACK_PLAN_GATE: "auto" });
  assert.deepEqual(await launchEnv(null, `${gateRepo}-missing`, "off"), { SSTACK_UNATTENDED: "1", SSTACK_PLAN_GATE: "inbox" });
  assert.deepEqual(await launchEnv(null, `${gateRepo}-missing`, "auto"), { SSTACK_UNATTENDED: "1", SSTACK_PLAN_GATE: "auto" });
} finally {
  await db.delete(linearOptIns).where(eq(linearOptIns.user_id, gateUser));
  await db.delete(user).where(eq(user.id, gateUser));
  await db.delete(repoSstackConfig).where(eq(repoSstackConfig.repo, gateRepo));
}

const slot = { id: TEST_MACHINE_ID, repos: ["ski043/factory-demo"], maxInFlight: 2 };
const sent: { threadId: string; message: string }[] = [];
const realThreads = { ...threads };
threads.state = async () => "running";
threads.send = async (threadId, message) => void sent.push({ threadId, message });

await assert.rejects(sourceFor("linear").ready(), /Linear API was called during a regression run/, "the real Linear client refuses to run in a regression");

const id = `launch-regress-${Date.now()}`;
const jid = jobId("linear", id);
// Claimed by the label, so removing it stops the job; an assignee-picked job has no label to lose.
await db.insert(jobs).values(linearJob(id, id, { source_state: { state: null, labels: ["hive"], factoryCommentIds: [] } }));
try {
  assert.equal(await claimLaunch(id, "pending:1", slot), true, "the first launch claims the job");
  assert.equal(await claimLaunch(id, "pending:2", slot), false, "a second launch, after a crash or timeout, does not");
  assert.deepEqual(
    (await pendingLaunches()).find((p) => p.key === id),
    { key: id, repo: "ski043/factory-demo", marker: "pending:1", branch: `hive/${id}`, stage: "queued", execution: null, sandbox_id: null, codex_slot: null },
  );
  await releaseLaunch(id, "pending:2");
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, id)))[0]!.t3_thread_id, "pending:1", "only the holder's marker is released");
  await releaseLaunch(id, "pending:1");
  assert.equal(await claimLaunch(id, "pending:3", slot), true, "a released job can launch again");
  // The binding × stop state space (runner/binding.ts). Each cell checks the predicate, its SQL
  // twin, what deliverStops does, and whether a retry claim may start a new attempt.
  const stop = { stage: "failed" as const, stage_event_id: `stop:${id}:1:x`, stop_event_id: `stop:${id}:1:x`, stage_summary: "Stopped: test." };
  const watchdogFail = { stage: "failed" as const, stage_event_id: `watchdog:${id}:1:x`, stop_event_id: null, stage_summary: "Watchdog." };
  const mergedAfterStop = { stage: "merged" as const, stage_event_id: `merged:${id}:x`, stop_event_id: `stop:${id}:1:x`, stage_summary: "Merged." };
  const cells = [
    { name: "none, not stopped", row: { ...watchdogFail, t3_thread_id: null, stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "none, stopped", row: { ...stop, t3_thread_id: null, stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "pending, not stopped", row: { ...watchdogFail, t3_thread_id: "pending:5", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "pending, stopped (owed)", row: { ...stop, t3_thread_id: "pending:5", stop_sent_to: null }, delivers: false, reclaim: false },
    { name: "bound, not stopped", row: { ...watchdogFail, t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: false, reclaim: true },
    { name: "bound, stopped, not sent", row: { ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: null }, delivers: true, reclaim: false },
    { name: "bound, stopped, sent", row: { ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" }, delivers: false, reclaim: true },
    {
      name: "bound, stopped, sent to an older thread",
      row: { ...stop, t3_thread_id: "mcp:regress-b", stop_sent_to: "mcp:regress-a" },
      delivers: true,
      reclaim: false,
    },
    {
      name: "bound, still working",
      row: { stage: "implementing" as const, stage_event_id: "e", stop_event_id: null, stage_summary: "s", t3_thread_id: "mcp:regress-a", stop_sent_to: null },
      delivers: false,
      reclaim: false,
    },
    {
      name: "bound, stopped, merged before the stop was sent",
      row: { ...mergedAfterStop, t3_thread_id: "mcp:regress-a", stop_sent_to: null },
      delivers: true,
      reclaim: false,
    },
    {
      name: "pending, stopped, merged before the thread was known",
      row: { ...mergedAfterStop, t3_thread_id: "pending:6", stop_sent_to: null },
      delivers: false,
      reclaim: false,
    },
    {
      name: "bound, stopped, merged, sent",
      row: { ...mergedAfterStop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" },
      delivers: false,
      reclaim: false,
    },
  ];
  const sqlSays = async (condition: ReturnType<typeof sql> | undefined) =>
    (
      await db
        .select({ key: jobs.key })
        .from(jobs)
        .where(and(eq(jobs.id, jid), condition))
    ).length > 0;
  for (const cell of cells) {
    await db.update(jobs).set(cell.row).where(eq(jobs.id, jid));
    const [row] = await db.select().from(jobs).where(eq(jobs.id, jid));
    assert.equal(stopDeliverable(row!), cell.delivers, `${cell.name}: stop deliverable`);
    assert.equal(await sqlSays(stopDeliverableSql), cell.delivers, `${cell.name}: SQL agrees on deliverable`);
    assert.equal(canReclaim(row!), cell.reclaim, `${cell.name}: retry claim allowed`);
    assert.equal(await sqlSays(sql`coalesce(${canReclaimSql}, false)`), cell.reclaim, `${cell.name}: SQL agrees on retry claim`);
    sent.length = 0;
    assert.deepEqual(await deliverStops(jid), cell.delivers ? [id] : [], `${cell.name}: deliverStops`);
    assert.deepEqual(await deliverStops(jid), [], `${cell.name}: a second deliverStops sends nothing`);
    assert.deepEqual(
      sent.map((m) => m.threadId),
      cell.delivers ? [cell.row.t3_thread_id] : [],
      `${cell.name}: the stop message reaches the bound thread once`,
    );
  }

  // The guard as the retry claim uses it, inside ON CONFLICT DO UPDATE.
  const retryClaim = () =>
    db
      .insert(jobs)
      .values(linearJob(id, id))
      .onConflictDoUpdate({ target: jobs.id, set: { attempt: sql`${jobs.attempt} + 1` }, setWhere: canReclaimSql })
      .returning({ attempt: jobs.attempt });
  await db
    .update(jobs)
    .set({ ...stop, t3_thread_id: "pending:8", stop_sent_to: null })
    .where(eq(jobs.id, jid));
  assert.deepEqual(await retryClaim(), [], "a retry claim is refused while a stopped launch is pending");
  await db
    .update(jobs)
    .set({ ...stop, t3_thread_id: "mcp:regress-a", stop_sent_to: "mcp:regress-a" })
    .where(eq(jobs.id, jid));
  assert.equal((await retryClaim()).length, 1, "and allowed once the stop reached the thread");

  // Transitions out of "pending, stopped": the thread appears, or recovery finds none.
  await db
    .update(jobs)
    .set({ ...stop, t3_thread_id: "pending:6", stop_sent_to: null })
    .where(eq(jobs.id, jid));
  sent.length = 0;
  assert.deepEqual(
    await bindThread(id, "mcp:regress-late"),
    { bound: id, threadId: "mcp:regress-late", stopped: true },
    "binding delivers the owed stop at once",
  );
  assert.deepEqual(
    sent.map((m) => m.threadId),
    ["mcp:regress-late"],
    "to the thread it just bound",
  );
  assert.equal(canReclaim((await db.select().from(jobs).where(eq(jobs.id, jid)))[0]!), true, "and then a retry may claim");
  await db
    .update(jobs)
    .set({ ...stop, t3_thread_id: "pending:9", stop_sent_to: null })
    .where(eq(jobs.id, jid));
  await db
    .update(jobs)
    .set({ stage: "merged", stage_event_id: `merged:${id}:late`, stage_summary: "Merged." })
    .where(eq(jobs.id, jid));
  sent.length = 0;
  assert.equal((await bindThread(id, "mcp:regress-merged")).stopped, true, "a PR that merged before the stop reached its thread still gets the stop");
  assert.deepEqual(
    sent.map((m) => m.threadId),
    ["mcp:regress-merged"],
  );
  assert.match(sent[0]!.message, /^Stop working on .+\. The factory stopped this run\./, "and the message does not quote the merge as the reason");
  await db
    .update(jobs)
    .set({ ...stop, t3_thread_id: "pending:7", stop_sent_to: null })
    .where(eq(jobs.id, jid));
  await releaseLaunch(id, "pending:7");
  const [cleared] = await db.select().from(jobs).where(eq(jobs.id, jid));
  assert.equal(stopDeliverable(cleared!), false, "recovery that finds no thread leaves nothing to deliver");
  assert.equal(canReclaim(cleared!), true, "and a retry may claim");
  assert.deepEqual(await deliverStops(jid), []);

  // Missed stop webhooks: each tick asks Linear about claimed jobs and stops the ones it took away.
  const node = (over: Record<string, unknown> = {}) => ({
    id,
    archivedAt: null,
    trashed: null,
    state: { type: "started", name: "In Progress" },
    labels: { nodes: [{ name: "hive" }] },
    ...over,
  });
  const sourceReading = (issuesByIds: () => Promise<unknown[]>) =>
    createLinearAdapter(() => ({ client: { issuesByIds } as never, db, limits: factorySchema.parse({}) }));
  const stops: string[] = [];
  const recordStop = async (stopped: string, detail: string) => {
    // Never touch a live job, whatever the scoping above does.
    assert.equal(stopped, jid, "the regression only stops its own job");
    stops.push(detail);
    await db
      .update(jobs)
      .set({ stage: "failed", stage_event_id: `stop:${id}:x` })
      .where(eq(jobs.id, jid));
    return "stopped";
  };
  const working = () => db.update(jobs).set({ stage: "implementing", stage_event_id: "e" }).where(eq(jobs.id, jid));
  const cases = [
    { name: "still labeled and open", fetch: async () => [node()], stop: undefined },
    { name: "label removed", fetch: async () => [node({ labels: { nodes: [{ name: "bug" }] } })], stop: "the hive label was removed in Linear" },
    { name: "canceled", fetch: async () => [node({ state: { type: "canceled", name: "Canceled" } })], stop: "issue moved to Canceled in Linear" },
    { name: "archived", fetch: async () => [node({ archivedAt: "2026-10-24T00:00:00Z" })], stop: "the issue was archived or deleted in Linear" },
    { name: "deleted (not returned)", fetch: async () => [], stop: "the issue was deleted in Linear" },
  ];
  for (const c of cases) {
    await working();
    stops.length = 0;
    const result = await reconcileStops({ sources: [sourceReading(c.fetch)], stop: recordStop, only: [jid] });
    assert.deepEqual(stops, c.stop ? [c.stop] : [], `${c.name}: ${JSON.stringify(result)}`);
    if (c.stop) {
      await reconcileStops({ sources: [sourceReading(c.fetch)], stop: recordStop, only: [jid] });
      assert.equal(stops.length, 1, `${c.name}: a repeat tick records no second stop`);
    }
  }
  await working();
  stops.length = 0;
  const linearDown = await reconcileStops({
    sources: [
      sourceReading(async () => {
        throw new Error("Linear is down");
      }),
    ],
    stop: recordStop,
    only: [jid],
  });
  assert.deepEqual(linearDown, { unknown: "Linear is down" });
  assert.deepEqual(stops, [], "a failed Linear fetch stops nothing");

  // Every per-job T3 call goes through the job's host, so a fake host sees exactly what T3 would.
  const calls: { command: string; args: string[]; options?: ExecOptions }[] = [];
  let shown: Record<string, unknown> = { archived: false, worktreePath: "/sandbox/wt", activeRunId: null };
  const fake: JobHost = {
    t3: "/sandbox/t3",
    run: async (command, args, options) => {
      calls.push({ command, args, options });
      if (args[1] === "start") return { stdout: '{"threadId":"mcp:fake"}', stderr: "" };
      if (args[1] === "show" && args[2] === "mcp:gone")
        throw Object.assign(new Error("exit 1"), { code: 1, stdout: "", stderr: "Thread mcp:gone is no longer available" });
      if (args[1] === "show") return { stdout: JSON.stringify({ thread: shown }), stderr: "" };
      return { stdout: "", stderr: "" };
    },
    readFile: async () => null,
    writeFile: async () => {},
    exists: async (path) => path === "/sandbox/wt",
    list: async () => [],
    mtimeMs: async () => 0,
    remove: async () => {},
  };
  const harness = { provider: "codex", model: "gpt-5.5" };
  assert.equal(await startThread(fake, "/sandbox/repo", "hive/FAC-1", "FAC-1 Title", "Work FAC-1", harness), "mcp:fake");
  assert.deepEqual(
    calls,
    [
      {
        command: "/sandbox/t3",
        args: [
          "thread",
          "start",
          "/sandbox/repo",
          "-",
          "--worktree",
          "origin/main",
          "--branch",
          "hive/FAC-1",
          "--title",
          "FAC-1 Title",
          "--provider",
          "codex",
          "--model",
          "gpt-5.5",
          "--json",
        ],
        options: { input: "Work FAC-1", timeoutMs: 60_000, maxBuffer: 16 * 1024 * 1024 },
      },
    ],
    "the launch runs t3 thread start on the job's host, with the message on stdin and the harness as flags",
  );
  calls.length = 0;
  // The gate reaches the agent as a file, not env: `t3 thread start` has no env flag, so a launch writes
  // sstack's git-ignored local layer in the checkout before T3 makes the worktree, then in the worktree.
  const SEED_DIR = "/sandbox/repo";
  const GATE_WT = "/sandbox/wt-gate";
  const seedPath = `${SEED_DIR}/${LOCAL_CONFIG}`;
  const worktreePath = `${GATE_WT}/${LOCAL_CONFIG}`;
  const excludePath = `${SEED_DIR}/.git/info/exclude`;
  const existing = '[dispatch]\nvia = "headless"\n# note\n[unattended]\nplan_gate = "auto"\n';

  /** A host with an in-memory file map that records every write and every call, in order. */
  type GateOpts = { seed?: string; worktree?: string; startFails?: Error; worktreeWriteFails?: boolean; ignoreExit?: number; showHangs?: boolean };
  function gateFiles({ seed, worktree = GATE_WT, startFails, worktreeWriteFails, ignoreExit = 0, showHangs = false }: GateOpts = {}) {
    const files = new Map<string, string>([[excludePath, "# git excludes\n"], ...(seed === undefined ? [] : ([[seedPath, seed]] as [string, string][]))]);
    const writes: { path: string; text: string }[] = [];
    const calls: string[] = [];
    const host: JobHost = {
      ...fake,
      run: async (command, args) => {
        const sub = command === "git" ? (args[0] === "-C" ? args[2] : args[0]) : args[1];
        calls.push(command === "git" ? `git ${sub}` : sub === "start" ? "start" : `t3 ${sub}`);
        if (command !== "git") {
          if (startFails) throw startFails;
          if (showHangs && sub === "show") return new Promise<never>(() => undefined);
          return { stdout: sub === "start" ? '{"threadId":"mcp:gate"}' : JSON.stringify({ thread: { worktreePath: worktree || null } }), stderr: "" };
        }
        if (sub === "check-ignore" && ignoreExit) throw Object.assign(new Error(`check-ignore exited ${ignoreExit}`), { code: ignoreExit });
        return { stdout: args.includes("--git-path") ? ".git/info/exclude\n" : "abc1234\n", stderr: "" };
      },
      readFile: async (path) => files.get(path) ?? null,
      writeFile: async (path, text) => {
        if (worktreeWriteFails && path === worktreePath) throw Object.assign(new Error("EACCES"), { code: "EACCES" });
        files.set(path, text);
        writes.push({ path, text });
        calls.push(`write ${path}`);
      },
      remove: async (path) => void (files.delete(path), calls.push(`remove ${path}`)),
    };
    return { host, files, writes, calls, worktree };
  }

  /** One launch through the real startUnattended; a worktree of "" is one T3 never names. */
  const gateLaunch = (files: ReturnType<typeof gateFiles>, gate: PlanGate = "inbox", worktreeOf = async () => files.worktree as string | undefined) => {
    const start = () => startThread(files.host, SEED_DIR, "hive/FAC-1", "FAC-1 Title", "Work FAC-1", harness);
    return startUnattended(files.host, SEED_DIR, gate, start, worktreeOf, maybeStarted);
  };
  const startGate = (files = gateFiles(), gate: PlanGate = "inbox") =>
    gateLaunch(files, gate).then(
      (started) => ({ ...files, started }),
      (error: unknown) => ({ ...files, started: error as Error }),
    );

  /** What every launch must write, and in what order; a path that skips a write fails here. */
  function assertGateFileWritten(writes: { path: string; text: string }[], calls: string[], gate: PlanGate) {
    const seed = calls.indexOf(`write ${seedPath}`);
    const start = calls.indexOf("start");
    const worktree = calls.indexOf(`write ${worktreePath}`);
    assert.ok(seed >= 0 && start > seed && worktree > start, `seed, then t3 thread start, then the worktree copy: ${calls.join(", ")}`);
    const [text, own] = [writes.find((w) => w.path === seedPath)?.text, writes.find((w) => w.path === worktreePath)?.text];
    assert.ok(text?.includes(`plan_gate = "${gate}"`) && own?.includes(`plan_gate = "${gate}"`), `both copies state this job's gate: ${text}`);
    assert.ok(!own?.includes("hive:launch-seed"), "the worktree's own copy carries no seed marker");
  }

  assert.equal(unattendedConfig("", "inbox"), '[unattended]\nenabled = true\nplan_gate = "inbox"\n', "an inbox gate is that file, whole");
  assert.equal(unattendedConfig("", "auto"), '[unattended]\nenabled = true\nplan_gate = "auto"\n', "an auto gate is that file, whole");
  const mergedText = '[dispatch]\nvia = "headless"\n# note\n[unattended]\nplan_gate = "inbox"\nenabled = true\n';
  assert.equal(unattendedConfig(existing, "inbox"), mergedText, "an existing local config keeps every other line and key");

  for (const seed of [undefined, existing]) {
    const run = await startGate(gateFiles({ seed }));
    assertGateFileWritten(run.writes, run.calls, "inbox");
    assert.equal(run.files.get(seedPath), seed, "the checkout keeps its own file: made for this launch, it is gone again");
  }

  // A clear start failure restores the checkout's file; a start that may have made a thread keeps its seed.
  const noThread = Object.assign(new Error("t3: project not found"), { code: "ENOENT" });
  const mayRun = new MaybeStartedError("t3 thread start printed no thread id");
  for (const [error, kept] of [
    [noThread, false],
    [mayRun, true],
  ] as const) {
    const run = await startGate(gateFiles({ seed: existing, startFails: error }));
    assert.deepEqual(
      [String(run.started).includes(error.message), run.files.get(seedPath) === existing],
      [true, !kept],
      "the failure reaches the caller and only an ambiguous start keeps its seed",
    );
  }

  // An orphaned seed reads back as the file it replaced, so the next launch restores that and not the seed.
  const orphan = gateFiles({ seed: existing });
  assert.equal(await gateLaunch(orphan, "auto", async () => undefined), "mcp:gate", "a thread T3 started is still the launch's thread");
  assert.match(orphan.files.get(seedPath) ?? "", /plan_gate = "auto"/, "a worktree T3 never names leaves the seed holding this job's gate");
  await startGate(orphan, "inbox");
  assert.equal(orphan.files.get(seedPath), existing, "the launch after an orphaned seed restores the original, not the stale seed");
  assert.ok(
    orphan.writes.some((w) => w.path === worktreePath && w.text.includes("[dispatch]")),
    "and the user's other keys reach the worktree",
  );

  const broken = gateFiles({ seed: "[unattended\n" });
  assert.match(String((await startGate(broken)).started), /not valid TOML/, "a malformed local config stops the launch before anything is written");
  assert.deepEqual([broken.calls, broken.files.get(seedPath)], [[], "[unattended\n"], "so the checkout is untouched and no thread starts");

  const unignored = await startGate(gateFiles({ ignoreExit: 1 }));
  assert.equal(unignored.files.get(excludePath), "# git excludes\n.sstack/local/\n", "a repo that does not ignore the local layer gets it in info/exclude");
  const gitBroken = await startGate(gateFiles({ ignoreExit: 2 }));
  assert.match(String(gitBroken.started), /check-ignore exited 2/, "a broken check-ignore stops the launch instead of duplicating the line");

  const gateBase = {
    key: "k",
    sandbox_id: null,
    attempt: 1,
    source: "linear" as const,
    repo: SEED_DIR,
    branch: "hive/k",
    threadTitle: "k",
    message: "m",
    harness,
    ticket: null,
    owner: null as string | null,
  };
  const gateEntry = (over: Partial<typeof gateBase> = {}) => ({ ...gateBase, ...over });

  // A failure after start returns the id: the thread is live, so it is bound and its seed stays.
  const wedged = gateFiles({ worktreeWriteFails: true });
  const boundKeys: string[] = [];
  const releasedKeys: string[] = [];
  const gates = await launchEntries([gateEntry()], {
    claim: async () => true,
    start: () => gateLaunch(wedged),
    bind: async (key, id) => void boundKeys.push(`${key}:${id}`),
    release: async (key) => void releasedKeys.push(key),
    now: Date.now,
  });
  assert.deepEqual([gates[0]?.threadId, boundKeys, releasedKeys], ["mcp:gate", ["k:mcp:gate"], []], "a post-start failure binds, never releases");
  assert.match(wedged.files.get(seedPath) ?? "", /plan_gate = "inbox"/, "and leaves the seed, because the worktree never got its copy");

  const [hung, hungBound] = [gateFiles({ showHangs: true }), [] as string[]]; // a hung show must not hold the queue
  const [hungLaunch] = await launchEntries([gateEntry({ key: "hung" })], {
    claim: async () => true,
    start: () => startLead(hung.host, SEED_DIR, gateEntry({ key: "hung" }), "Work HUNG-1", harness, [], undefined, 30),
    bind: async (key, id) => void hungBound.push(`${key}:${id}`),
    release: async () => assert.fail("a deadline launch is not released"),
    now: Date.now,
  });
  assert.deepEqual([hungLaunch?.threadId, Number(hungLaunch?.startMs) < 1_000, hungBound], ["mcp:gate", true, ["hung:mcp:gate"]]);
  assert.match(hung.files.get(seedPath) ?? "", /plan_gate = "inbox"/, "the deadline leaves the seed");

  // MUTATION CHECK for the launch sites: one that starts a thread itself, without startLead, fails here.
  const launchSource = readFileSync(new URL("../runner/launch.ts", import.meta.url), "utf8").replace(/^\s*\/\/.*$/gm, "");
  assert.equal(launchSource.match(/startLead\(/g)?.length, 3, "both start sites call startLead, plus its definition");
  assert.equal(launchSource.match(/startThread\(/g)?.length, 2, "and startThread is only defined and called by startLead");
  {
    // The owner's opt-in, end to end through the launch path: inbox wins over the repo's "auto".
    const optedUser = `gate-opt-${Date.now()}`;
    const optedRepo = `${optedUser}/repo`;
    try {
      await db.insert(user).values({ id: optedUser, name: optedUser, email: `${optedUser}@example.com` });
      await db.insert(linearOptIns).values({ user_id: optedUser, plan_approval: true, updated_at: new Date() });
      await db.insert(repoSstackConfig).values({
        repo: optedRepo,
        files: { ".sstack/config.toml": '[unattended]\nplan_gate = "auto"\n' },
        sha: "test",
        read_at: new Date(),
      });
      await db.insert(repoSettings).values({ repo: optedRepo, autonomy: "auto", updated_at: new Date(), updated_by: optedUser });
      const [policy] = await db.select().from(repoSettings).where(eq(repoSettings.repo, optedRepo));
      const launch = gateFiles();
      const entry = gateEntry({ key: "gate-opt", repo: optedRepo, threadTitle: "GATE-1", owner: optedUser });
      assert.equal(await startLead(launch.host, SEED_DIR, entry, "Work GATE-1", harness, [policy!]), "mcp:gate");
      assertGateFileWritten(launch.writes, launch.calls, "inbox");
    } finally {
      await db.delete(repoSettings).where(eq(repoSettings.repo, optedRepo));
      await db.delete(linearOptIns).where(eq(linearOptIns.user_id, optedUser));
      await db.delete(user).where(eq(user.id, optedUser));
      await db.delete(repoSstackConfig).where(eq(repoSstackConfig.repo, optedRepo));
    }
  }
  assert.equal(await realThreads.state("mcp:fake", fake), "stopped", "an idle thread whose worktree the host has is stopped");
  assert.deepEqual(calls, [{ command: "/sandbox/t3", args: ["thread", "show", "mcp:fake", "--json"], options: { timeoutMs: 20_000 } }]);
  shown = { ...shown, activeRunId: "run-1" };
  assert.equal(await realThreads.state("mcp:fake", fake), "running");
  shown = { ...shown, worktreePath: "/elsewhere" };
  assert.equal(await realThreads.state("mcp:fake", fake), "gone", "a worktree missing on the job's host means gone");
  assert.equal(await realThreads.state("mcp:gone", fake), "gone", "T3 saying the thread is gone, through the host's error, means gone");
  const odd: JobHost = {
    ...fake,
    run: async () => ({
      stdout: JSON.stringify({
        thread: { archived: false, worktreePath: null, activeRunId: null, status: null },
        messages: [null, { role: "assistant", text: null }, { role: "tool" }, { role: "assistant", text: "done" }],
      }),
      stderr: "",
    }),
  };
  assert.deepEqual(
    await realThreads.read("mcp:odd", odd),
    { state: "stopped", status: null, lastMessage: "done" },
    "nulls and unexpected message shapes from T3 never throw",
  );
  calls.length = 0;
  assert.equal(await realThreads.state("pending:1", fake), "running", "a pending launch asks no host");
  assert.equal(calls.length, 0);
  await assert.rejects(
    realThreads.state("mcp:real", localHost),
    /t3 thread show was called during a regression run/,
    "the local host still refuses T3 in a regression",
  );
  await assert.rejects(startThread(localHost, "/repo", "hive/X", "X", "m", harness), /t3 thread start was called during a regression run/);
  await assert.rejects(realThreads.send("mcp:real", "m", localHost), /t3 thread send was called during a regression run/);

  // The job's host comes from the resolver: a stop is shown and sent on the host it names.
  shown = { archived: false, worktreePath: "/sandbox/wt", activeRunId: "run-1" };
  calls.length = 0;
  Object.assign(threads, realThreads);
  const resolve = hosts.forJob;
  hosts.forJob = (job) => (job.key === id ? fake : localHost);
  try {
    await db
      .update(jobs)
      .set({ ...stop, t3_thread_id: "mcp:fake", stop_sent_to: null, machine_id: TEST_MACHINE_ID })
      .where(eq(jobs.id, jid));
    assert.deepEqual(await deliverStops(jid), [id]);
  } finally {
    hosts.forJob = resolve;
    threads.state = async () => "running";
    threads.send = async (threadId, message) => void sent.push({ threadId, message });
  }
  assert.deepEqual(
    calls.map((c) => c.args.slice(0, 3)),
    [
      ["thread", "show", "mcp:fake"],
      ["thread", "send", "mcp:fake"],
    ],
  );
  assert.match(calls[1]!.options!.input!, /^Stop working on /, "the stop message goes to the fake host's stdin");

  // One failed start does not stop the batch; a clear failure frees its marker, a timeout keeps it.
  const markers = new Map<string, string>();
  const released: string[] = [];
  const entry = (key: string) => ({
    key,
    sandbox_id: null,
    attempt: 1,
    source: "linear" as const,
    repo: "ski043/factory-demo",
    branch: `hive/${key}`,
    threadTitle: key,
    message: "m",
    harness,
    ticket: null,
  });
  const results = await launchEntries([entry("A"), entry("B"), entry("C")], {
    claim: async (key, marker) => (markers.set(key, marker), true),
    start: async ({ key }) => {
      if (key === "A") throw new Error("t3: project not found");
      if (key === "B") throw Object.assign(new Error("timed out"), { killed: true });
      return `thread-${key}`;
    },
    bind: async () => undefined,
    release: async (key) => void released.push(key),
    now: () => 1,
  });
  assert.deepEqual(
    results.map((r) => [r.key, r.threadId ?? r.retry]),
    [
      ["A", "next pass"],
      ["B", "after launch recovery"],
      ["C", "thread-C"],
    ],
    "every entry is tried",
  );
  assert.deepEqual(released, ["A"], "only the clearly failed start releases its marker");

  // A recheck answers at once and runs the check on later queued steps, once GitHub settles.
  const timers: (() => void)[] = [];
  const queue: (() => Promise<unknown>)[] = [];
  let clock = 0;
  let unknown = 2;
  let checks = 0;
  const scheduler = recheckScheduler(
    {
      settled: async () => unknown-- <= 0,
      check: async () => ++checks,
      enqueue: (_name, step) => void queue.push(step),
      schedule: (run) => void timers.push(run),
      now: () => clock,
    },
    { waitMs: 100, pollMs: 10 },
  );
  assert.equal(scheduler.request(), "scheduled", "the intent returns without waiting");
  assert.equal(scheduler.request(), "already scheduled", "a second push joins the pending recheck");
  const drain = async () => {
    while (timers.length || queue.length) {
      timers.splice(0).forEach((run) => run());
      for (const step of queue.splice(0)) await step();
      clock += 10;
    }
  };
  await drain();
  assert.equal(checks, 1, "the check runs once, after GitHub settled");
  unknown = 1_000;
  scheduler.request();
  await drain();
  assert.equal(checks, 2, "a recheck that never settles still checks at its deadline");

  // A throwing GitHub round is retried and falls through to the check at the deadline; a throwing
  // check still frees the scheduler for the next request.
  let throwingChecks = 0;
  let failFinal = true;
  const flaky = recheckScheduler(
    {
      settled: async () => {
        throw new Error("the GitHub read failed");
      },
      check: async () => {
        throwingChecks++;
        if (failFinal) throw new Error("check failed");
        return "checked";
      },
      enqueue: (_name, step) => void queue.push(async () => step().catch(() => "step failed")),
      schedule: (run) => void timers.push(run),
      now: () => clock,
    },
    { waitMs: 50, pollMs: 10 },
  );
  flaky.request();
  await drain();
  assert.equal(throwingChecks, 1, "a settled() that keeps throwing still reaches the check at the deadline");
  failFinal = false;
  assert.equal(flaky.request(), "scheduled", "a check that threw leaves the scheduler free for the next request");
  await drain();
  assert.equal(throwingChecks, 2, "and that next recheck runs");

  // Child processes always settle, and output is parsed after awaiting it.
  const runWithInput = async (command: string, args: string[], input: string, timeoutMs: number) =>
    (await localHost.run(command, args, { input, timeoutMs })).stdout;
  assert.equal(await runWithInput("cat", [], "hello", 5_000), "hello", "stdin reaches the command");
  await assert.rejects(runWithInput("/nonexistent/t3", [], "x", 5_000), "a missing binary rejects");
  await assert.rejects(runWithInput("sh", ["-c", "exit 3"], "x", 5_000), "a failed exit rejects");
  await assert.rejects(
    runWithInput("sleep", ["5"], "x", 200).catch((error: { killed?: boolean }) => {
      assert.equal(error.killed, true, "a timeout is marked killed");
      throw error;
    }),
  );
  // A broken stdin pipe settles nothing by itself; the exit decides, and the failure says it happened.
  const big = "x".repeat(4 * 1024 * 1024);
  assert.equal(await runWithInput("sh", ["-c", "echo ok"], big, 5_000), "ok\n", "an exit 0 after EPIPE still succeeds with its output");
  const brokenPipe = await runWithInput("sh", ["-c", "exit 3"], big, 5_000).catch((error: unknown) => error);
  assert.ok((brokenPipe as { stdinError?: Error }).stdinError, "a failure after EPIPE carries the stdin error");
  assert.equal(maybeStarted(brokenPipe), true, "and counts as maybe started, so the marker is kept");
  const cleanFail = await runWithInput("sh", ["-c", "cat >/dev/null; exit 3"], big, 5_000).catch((error: unknown) => error);
  assert.equal(maybeStarted(cleanFail), false, "a non-zero exit that read all its input is a clear failure");
  const missing = await runWithInput("/nonexistent/t3", [], "x", 5_000).catch((error: unknown) => error);
  assert.equal(maybeStarted(missing), false, "a binary that never ran is a clear failure");
  const timedOut = await runWithInput("sleep", ["5"], "x", 200).catch((error: unknown) => error);
  assert.equal(maybeStarted(timedOut), true, "a timeout is maybe started");
  assert.equal(parseThreadId('{"threadId":"mcp:1"}'), "mcp:1");
  assert.throws(() => parseThreadId("not json"), MaybeStartedError, "unparsable output rejects as maybe-started");
  const unparsed = await launchEntries([entry("D")], {
    claim: async () => true,
    start: async () => parseThreadId("garbage"),
    bind: async () => undefined,
    release: async (key) => void released.push(key),
    now: () => 1,
  });
  assert.equal(unparsed[0]!.retry, "after launch recovery", "unparsable start output keeps the marker for recovery");
  assert.ok(!released.includes("D"));

  // Placement (R22): a repo whose snapshot has [test.mobile] runs local whatever the setting says.
  assert.equal(isMobileSnapshot({ ".sstack/project.toml": "[test.mobile]" }), true);
  assert.equal(isMobileSnapshot({ ".sstack/project.toml": "[test]\n  [test.mobile]  # ios\n" }), true, "an indented table line with a comment matches");
  for (const text of ["# [test.mobile]", "[test.mobile.ios]", "[test]\nmobile = true"])
    assert.equal(isMobileSnapshot({ ".sstack/project.toml": text }), false, `${JSON.stringify(text)} is not a mobile repo`);
  assert.equal(isMobileSnapshot({ ".sstack/config.toml": "[test.mobile]" }), false, "only project.toml counts");
  assert.equal(isMobileSnapshot({}), false);
  assert.equal(isMobileSnapshot(null), false);

  const [mobile, plain, none] = ["mobile", "plain", "none"].map((kind) => `${id}-${kind}/r`);
  const snapshot = (repo: string, text: string) => ({ repo, files: { ".sstack/project.toml": text }, sha: "sha", read_at: new Date() });
  await db.insert(repoSstackConfig).values([snapshot(mobile!, "[test.mobile]\n"), snapshot(plain!, '[test]\ncommand = "bun test"\n')]);
  const m = await mobileRepos([mobile!, plain!, none!]);
  assert.deepEqual([...m], [mobile], "only the repo whose snapshot has [test.mobile] is mobile");
  assert.equal((await mobileRepos([])).size, 0, "no repos, no query");
  type Launch = Extract<LaunchPlan, { kind: "launch" }>;
  const modalPlan: Launch = { kind: "launch", execution: "modal", harness, ticket: null };
  const localPlan: Launch = { ...modalPlan, execution: "local" };
  assert.equal((placeMobile(modalPlan, m.has(mobile!), null) as Launch).execution, "local", "a mobile job goes local when the setting is modal");
  assert.deepEqual(
    placeMobile(modalPlan, true, "this runner has no checkout of the repo"),
    { kind: "wait", reason: "a mobile repo runs only on a pool Mac, and this runner has no checkout of the repo" },
    "a mobile job that cannot run locally here waits, never Modal",
  );
  const flipped = placeMobile({ ...modalPlan, ticket: { execution: "modal", notes: [] } }, true, null) as Launch;
  assert.equal(flipped.execution, "local");
  assert.equal(flipped.ticket?.execution, undefined, "a ticket asking for Modal no longer says so");
  assert.match(flipped.ticket?.notes.join(" ") ?? "", /mobile tests/, "and says why");
  assert.equal(placeMobile(modalPlan, m.has(plain!), null), modalPlan, "a repo without [test.mobile] follows the setting");
  assert.equal(placeMobile(localPlan, m.has(plain!), null), localPlan, "local stays local");
  assert.equal(placeMobile(modalPlan, m.has(none!), null), modalPlan, "a repo with no snapshot follows the setting");

  // No step can stall the queue: a hung step times out, a throwing one is caught, the next runs.
  const events: string[] = [];
  const q = serialQueue((event) => void events.push(event), 50);
  void q.serial("hang", () => new Promise(() => {}));
  void q.serial("throw", async () => {
    throw new Error("boom");
  });
  const after = await q.serial("after", async () => "ran");
  assert.equal(after, "ran", "the step after a hung and a throwing one still runs");
  assert.deepEqual(events, ["hang:error", "throw:error", "after"]);

  // A step that rejects after its timeout is logged, not left as an unhandled rejection.
  let unhandled = 0;
  const count = () => void unhandled++;
  process.on("unhandledRejection", count);
  const lateEvents: string[] = [];
  const late = serialQueue((event) => void lateEvents.push(event), 20);
  await late.serial("late", () => new Promise((_, reject) => setTimeout(() => reject(new Error("late")), 60)));
  await new Promise((resolve) => setTimeout(resolve, 100));
  process.off("unhandledRejection", count);
  assert.deepEqual(lateEvents, ["late:error", "late:late-error"]);
  assert.equal(unhandled, 0, "no unhandled rejection");

  // The hourly cleanup advances its clock only on success and never overlaps itself.
  let t = 0;
  let runs = 0;
  let fail = true;
  let release: () => void = () => {};
  const hourly = everyAtMost(
    100,
    async () => {
      runs++;
      if (fail) throw new Error("cleanup failed");
      await new Promise<void>((resolve) => (release = resolve));
      return "cleaned";
    },
    () => t,
  );
  assert.equal(await hourly(), undefined, "not due before the interval");
  t = 100;
  assert.deepEqual(await hourly(), { error: "cleanup failed" });
  assert.equal(runs, 1);
  fail = false;
  const slow = hourly();
  assert.equal(await hourly(), undefined, "a failed run is retried, but never while one is still going");
  release();
  assert.equal(await slow, "cleaned");
  assert.equal(runs, 2, "the failed hour was retried at the next chance");
  t = 150;
  assert.equal(await hourly(), undefined, "after a success the clock waits a full interval again");

  // R10a: only the provider's structured error marks a rate limit, never what the agent said.
  const say = (text: string, extra: object = {}) => ({ type: "assistant", message: { content: text }, ...extra });
  const hit = say("API Error: 429", { error: "rate_limit", isApiErrorMessage: true });
  const transcript = (...lines: object[]) => lines.map((l) => JSON.stringify(l)).join("\n");
  for (const [want, ...lines] of [
    [true, { type: "user" }, hit],
    [false, hit, say("recovered")],
    [false, say("Tests failed: expected HTTP 429, received 200."), say("Failed to implement rate limiting")],
    [false, say("API Error: 429")],
    [false, say("ok"), { ...hit, isSidechain: true }],
    [true, hit, { type: "assistant", isSidechain: true }],
    [true, hit, { type: "user", message: { content: [{ type: "tool_result" }] } }],
  ] as const)
    assert.equal(transcriptRateLimited(transcript(...lines)), want, JSON.stringify(lines));
  const event = (type: string, more: object = {}) => ({ type: "event_msg", payload: { type, ...more } });
  const full = event("error", { codex_error_info: "usage_limit_exceeded", message: "You've hit your usage limit." });
  for (const [want, ...events] of [
    [true, event("task_started"), full],
    [false, full, event("task_started")],
    [false, event("task_started"), event("agent_message", { message: "I fixed the rate limit handling." })],
  ] as const)
    assert.equal(parseRollout(transcript({ type: "session_meta", payload: { id: "t1" } }, ...events))!.rateLimited, want, JSON.stringify(events));
  const [rl, acct] = [`${id}-rl`, `${id}-acct`];
  const now = new Date();
  await db.insert(agentAccounts).values({ id: acct, provider: "claude", kind: "subscription", label: acct, sealed: seal("t", newKeyPair().publicKey) });
  const seed = async (key: string, job: object) => {
    await db.insert(jobs).values(linearJob(key, key, { stage: "implementing", machine_id: TEST_MACHINE_ID, ...job }));
    await db.insert(runRows).values({ session_id: `${key}-s`, job_key: key, branch: `hive/${key}`, account_id: acct, started_at: now, last_event_at: now });
  };
  await seed(rl, { t3_thread_id: "mcp:rl", attempt: 1 });
  let text = transcript(say("Tests failed: expected HTTP 429, received 200."));
  threads.state = async (threadId) => (["mcp:rl", "mcp:hold", "mcp:unreported"].includes(threadId ?? "") ? "stopped" : "running");
  github.pullRequestForBranch = async () => null; // the watchdog looks for the branch's PR before it fails a rate-limited job
  rateLimitRuntime.signal = async () => transcriptRateLimited(text);
  await watchdog();
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, rl)))[0]!.stage, "implementing", "a stopped thread with no provider signal is not failed");
  text = transcript({ type: "user" }, hit);
  await assert.rejects(watchdog(), /deployed ingest function/); // the failure row is written before the event posts
  const waiting = `${id}-wait`;
  await db.insert(jobs).values(linearJob(waiting, waiting, { stage: "queued" }));
  const limits = config.factory.sandbox;
  Object.assign(sandboxRuntime, {
    image: () => ({ imageId: "im-test", t3Version: limits.t3Version, versions: pinnedVersions(limits), factoryCommit: "abc", builtAt: "now" }),
    driverOf: (provider: string) => provider,
    account: async () => "wait",
  });
  assert.deepEqual(await launchInSandboxes([entry(waiting)], slot), [], "no thread starts");
  const { stage, stage_summary, t3_thread_id, machine_id } = (await db.select().from(jobs).where(eq(jobs.key, waiting)))[0]!;
  assert.deepEqual([stage, stage_summary, t3_thread_id, machine_id], ["queued", "Waiting for the team pool", null, null], "1.4: the job waits for the pool");
  // A Codex account a local job holds is leased, so a cloud job on it waits instead of running the same login twice.
  const [local, cloud] = [`${id}-local`, `${id}-cloud`];
  await db.insert(jobs).values([linearJob(local, local, { codex_slot: `account:${id}-acct` }), linearJob(cloud, cloud, { stage: "queued" })]);
  Object.assign(sandboxRuntime, { account: async () => ({ id: `${id}-acct`, secret: "s" }) });
  assert.deepEqual(
    await launchInSandboxes([{ ...entry(cloud), harness: { provider: "codex", model: "m" } }], slot),
    [],
    "the account is leased to the local job",
  );
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, cloud)))[0]!.machine_id, null, "the cloud job is not claimed");
  // R27d: no own, shared or pool account and no runner login: the job stays queued and says to connect one.
  const blocked = `${id}-no-account`;
  await db.insert(jobs).values(linearJob(blocked, blocked, { stage: "queued" }));
  const slots = sandboxRuntime.slots;
  Object.assign(sandboxRuntime, { account: async () => null, slots: () => [] });
  assert.deepEqual(await launchInSandboxes([{ ...entry(blocked), harness: { provider: "codex", model: "m" } }], slot), [], "no thread starts");
  const queued = (await db.select().from(jobs).where(eq(jobs.key, blocked)))[0]!;
  assert.deepEqual([queued.stage, queued.stage_summary, queued.machine_id], ["queued", NO_ACCOUNT, null], "R27d: the job asks its owner to connect an account");
  Object.assign(sandboxRuntime, { account: async () => "wait", slots });
  // 1.3 on an untracked harness, whatever status T3 settled on: with a PR open the job stays at pr with one note and is never relaunched; with none it fails for the next account.
  const openPr = "https://github.com/ski043/factory-demo/pull/1";
  const posted: { jobKey?: string; stage?: string }[] = [];
  ingestClient.post = async (event) => (posted.push(event), ingest(db, [eventSchema.parse(event)])); // the stage posts go through the real projection
  const rows: { status: string; signal: boolean; pr: boolean; stage: string; inside?: boolean; merged?: boolean }[] = [
    { status: "failed", signal: false, pr: false, stage: "failed" },
    { status: "completed", signal: false, pr: false, stage: "waiting" },
    ...["failed", "completed", "interrupted"].flatMap((status) => [
      { status, signal: true, pr: false, stage: "failed" },
      { status, signal: true, pr: false, inside: true, stage: "implementing" },
      { status, signal: false, pr: true, stage: "pr" },
      { status, signal: true, pr: true, stage: "pr" },
      { status, signal: true, pr: true, inside: true, stage: "pr" },
      { status, signal: true, pr: false, merged: true, stage: "merged" },
      { status, signal: true, pr: false, merged: true, inside: true, stage: "merged" },
    ]),
  ];
  for (const { status, signal, stage, pr, inside, merged } of rows) {
    github.pullRequestForBranch = async () => (pr ? { url: openPr, state: "open" } : merged ? { url: openPr, state: "merged" } : null);
    const cx = `${id}-cx-${status}-${signal}${pr ? "-pr" : ""}${merged ? "-merged" : ""}${inside ? "-in" : ""}`;
    threads.read = async () => ({ state: "stopped", status, lastMessage: null });
    await seed(cx, { provider: "codex", t3_thread_id: `t-${cx}`, stage_at: inside ? new Date() : new Date(0) });
    rateLimitRuntime.signal = async () => signal;
    for (let pass = 0; pass < (signal ? 2 : 1); pass++) await inferUntracked({ only: [cx] });
    const retried: string[] = [];
    await relaunchRateLimited((async (jid: string) => (retried.push(jid), {})) as never);
    const row = (await db.select().from(jobs).where(eq(jobs.key, cx)))[0]!;
    const summary = row.stage_summary ?? "";
    const tag = `${status}/${signal}/${pr ? "pr" : merged ? "merged" : "no pr"}${inside ? "/inside the grace" : ""}: ${summary}`;
    assert.equal(row.stage, stage, tag);
    assert.equal(summary.includes(RATE_LIMITED), signal && !pr && !merged && !inside, tag);
    assert.equal(/rate limit/.test(summary), signal && pr, `${tag}: a PR held at pr says why`);
    assert.equal(posted.filter((e) => e.jobKey === cx && e.stage === "pr").length, stage === "pr" ? 1 : 0, `${tag}: exactly one pr note, however many passes`);
    if (stage === "failed") assert.ok(summary.includes(signal ? RATE_LIMITED : "its T3 thread failed"), tag);
    assert.equal(retried.includes(jobId("linear", cx)), signal && !pr && !merged && !inside, `${tag}: only a rate-limited attempt without a PR is retried`);
    if (merged)
      assert.deepEqual([row.pr_url, posted.filter((e) => e.jobKey === cx && e.stage === "merged").length], [openPr, 1], `${tag}: the merge is recorded once`);
  }
  const hold = `${id}-hold`;
  await seed(hold, { t3_thread_id: "mcp:hold", pr_url: openPr });
  rateLimitRuntime.signal = async () => true;
  for (let pass = 0; pass < 2; pass++) await watchdog();
  const held = (await db.select().from(jobs).where(eq(jobs.key, hold)))[0]!;
  assert.deepEqual([held.stage, /rate limit/.test(held.stage_summary ?? "")], ["pr", true], "a tracked rate-limited job with a PR stays at pr, never failed");
  assert.equal(posted.filter((e) => e.jobKey === hold && e.stage === "pr").length, 1, "its note is posted once");
  // Requested changes move it back to implementing (a new stage event); the next rate limit is a new note, still one per limit.
  const [heldRow] = await db.select().from(jobs).where(eq(jobs.key, hold));
  await ingestClient.post({
    eventId: runnerEventId("changes", heldRow!.external_id, "fb-1"),
    sessionId: heldRow!.session_id ?? runnerEventId("changes", heldRow!.external_id),
    at: Date.now(),
    kind: "stage",
    stage: "implementing",
    summary: "A reviewer requested changes; the thread is updating it.",
    jobKey: hold,
  } as never);
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, hold)))[0]!.stage, "implementing", "requested changes move the held job back to implementing");
  for (let pass = 0; pass < 2; pass++) await watchdog();
  const heldAgain = (await db.select().from(jobs).where(eq(jobs.key, hold)))[0]!;
  assert.deepEqual(
    [heldAgain.stage, /rate limit/.test(heldAgain.stage_summary ?? "")],
    ["pr", true],
    "a second rate limit after requested changes holds it at pr again",
  );
  assert.equal(posted.filter((e) => e.jobKey === hold && e.stage === "pr").length, 2, "one note per rate limit: two in total, none from the second pass");
  // The tracked job opened its PR but hit the limit before reporting it: no stored url, an open PR on its branch.
  const unreported = `${id}-unreported`;
  await seed(unreported, { t3_thread_id: "mcp:unreported" });
  github.pullRequestForBranch = async () => ({ url: openPr, state: "open" });
  for (let pass = 0; pass < 2; pass++) await watchdog();
  const kept = (await db.select().from(jobs).where(eq(jobs.key, unreported)))[0]!;
  assert.deepEqual(
    [kept.stage, kept.pr_url, /rate limit/.test(kept.stage_summary ?? "")],
    ["pr", openPr, true],
    "a tracked rate-limited job whose PR was never reported stays at pr",
  );
  assert.equal(posted.filter((e) => e.jobKey === unreported && e.stage === "pr").length, 1, "its note is posted once across two passes");
  const kicked: string[] = [];
  await relaunchRateLimited((async (jid: string) => (kicked.push(jid), {})) as never);
  assert.ok(!kicked.includes(jobId("linear", unreported)), "and is never relaunched");
  // Every other PR state on the tracked watchdog: a merged branch PR is the merge, a closed one (the lookup returns null) the normal fallback.
  const [mergedKey, closedKey] = [`${id}-tracked-merged`, `${id}-tracked-closed`];
  threads.state = async () => "stopped";
  rateLimitRuntime.signal = async () => true;
  for (const [key, pull] of [
    [mergedKey, { url: openPr, state: "merged" as const }],
    [closedKey, null],
  ] as const) {
    await seed(key, { t3_thread_id: `mcp:${key}` });
    github.pullRequestForBranch = async () => pull;
    for (let pass = 0; pass < 2; pass++) await watchdog();
    const tracked = (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!;
    const retriedKeys: string[] = [];
    await relaunchRateLimited((async (jid: string) => (retriedKeys.push(jid), {})) as never);
    if (pull)
      assert.deepEqual(
        [tracked.stage, tracked.pr_url, retriedKeys.includes(jobId("linear", key))],
        ["merged", openPr, false],
        "a merged branch PR is the merge, never a retry",
      );
    else
      assert.deepEqual(
        [tracked.stage, tracked.stage_summary?.includes(RATE_LIMITED), retriedKeys.filter((j) => j === jobId("linear", key)).length],
        ["failed", true, 1],
        "a closed, unmerged PR is the normal fallback",
      );
    assert.equal(posted.filter((e) => e.jobKey === key && e.stage === "merged").length, pull ? 1 : 0, `${key}: one merged event across two passes`);
  }
  // R10a: a failed, rate-limited attempt that already has a PR is never relaunched; the same job without one is, once.
  github.pullRequestForBranch = async () => null;
  const [withPr, noPr] = [`${id}-relaunch-pr`, `${id}-relaunch-nopr`];
  await seed(withPr, { stage: "failed", stage_summary: RATE_LIMITED, attempt: 1, pr_url: openPr });
  await seed(noPr, { stage: "failed", stage_summary: RATE_LIMITED, attempt: 1 });
  const relaunched: string[] = [];
  const result = await relaunchRateLimited((async (jid: string) => (relaunched.push(jid), {})) as never);
  assert.deepEqual(
    relaunched.filter((j) => j.endsWith("-relaunch-pr") || j.endsWith("-relaunch-nopr")),
    [jobId("linear", noPr)],
    "only the job with no PR is retried, once",
  );
  assert.ok(!result.some((r) => r.key === withPr) && result.some((r) => r.key === noPr), "the result has no entry for the job with a PR");
  // A failed marker job with no stored url whose branch has an open PR is not retried, and a failing lookup skips it.
  const [branchPr, lookupFails] = [`${id}-relaunch-branch-pr`, `${id}-relaunch-lookup-fails`];
  await seed(branchPr, { stage: "failed", stage_summary: RATE_LIMITED, attempt: 1 });
  await seed(lookupFails, { stage: "failed", stage_summary: RATE_LIMITED, attempt: 1 });
  github.pullRequestForBranch = async (_repo, branch) => {
    if (branch.includes("lookup-fails")) throw new Error("GitHub is down");
    return branch.includes("branch-pr") ? { url: openPr, state: "open" } : null;
  };
  relaunched.length = 0;
  await relaunchRateLimited((async (jid: string) => (relaunched.push(jid), {})) as never);
  assert.ok(
    relaunched.includes(jobId("linear", noPr)),
    "a job with no PR anywhere is still retried (and a failing lookup on another job does not stop the pass)",
  );
  assert.ok(!relaunched.includes(jobId("linear", branchPr)), "an unreported open branch PR blocks the retry");
  assert.ok(!relaunched.includes(jobId("linear", lookupFails)), "a lookup that throws skips the job instead of retrying it");
  // The PR was exposed after the watchdog's lookup: the relaunch pass settles the failed job itself (open -> pr, merged -> merged) and never retries it.
  for (const state of ["open", "merged"] as const) {
    const late = `${id}-relaunch-late-${state}`;
    await seed(late, { stage: "failed", stage_summary: RATE_LIMITED, attempt: 1 });
    github.pullRequestForBranch = async () => ({ url: openPr, state });
    const retriedLate: string[] = [];
    for (let pass = 0; pass < 2; pass++) await relaunchRateLimited((async (jid: string) => (retriedLate.push(jid), {})) as never);
    const settled = (await db.select().from(jobs).where(eq(jobs.key, late)))[0]!;
    const want = state === "open" ? "pr" : "merged";
    assert.deepEqual(
      [settled.stage, settled.pr_url],
      [want, openPr],
      `a failed job whose ${state} PR shows up at relaunch is settled at ${want} with the url stored`,
    );
    if (state === "open") assert.match(settled.stage_summary ?? "", /rate limit/, "the rate-limit note is the summary");
    assert.ok(!retriedLate.includes(jobId("linear", late)), `${state}: never retried`);
    assert.equal(posted.filter((e) => e.jobKey === late && e.stage === want).length, 1, `${state}: one ${want} event across two passes`);
  }
  const lead = { provider: "claudeAgent", model: "claude-opus-5-5" };
  assert.deepEqual(sandboxHarness(lead, "claudeAgent", true, limits.codexModel), { choice: lead }, "1.5: a pool Claude account keeps the Claude harness");
  console.log("launch regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(runRows).where(like(runRows.job_key, `${id}-%`));
  await db.delete(agentAccounts).where(like(agentAccounts.id, `${id}-%`));
  await db.delete(jobs).where(like(jobs.key, `${id}-%`));
  await db.delete(jobs).where(eq(jobs.id, jid));
  await db.delete(repoSstackConfig).where(like(repoSstackConfig.repo, `${id}-%`));
  process.exit(process.exitCode ?? 0);
}
