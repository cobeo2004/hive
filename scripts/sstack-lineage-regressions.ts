import "./test-guard";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray, like, type SQL } from "drizzle-orm";

const { db } = await import("../db/client");
const { agents, events, jobs, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { HostGoneError, localHost } = await import("../lib/host");
const { parseRollout } = await import("../lib/codex-usage");
const { costUsd, hasTokens } = await import("../lib/pricing");
const { branchSpend } = await import("../lib/spend");
const { sumUsage } = await import("../lib/transcript");
const { ingestClient, reconcileUsage } = await import("../runner/ops");
const { parseTs, recordSstackLineage } = await import("../runner/sstack-lineage");

const FIXTURES = join(import.meta.dirname, "fixtures/sstack-lineage");
const index = readFileSync(join(FIXTURES, "index.jsonl"), "utf8");
const [implement, review, pi] = index.split("\n").flatMap((l) => (l.startsWith("{") ? [JSON.parse(l) as { ts: string; secs: number; run_dir: string }] : []));
const endOf = (line: { ts: string }) => parseTs(line.ts, localHost);
const startOf = (line: { ts: string; secs: number }) => endOf(line) - Math.round(line.secs * 1000);

// --- parseTs: a naive time is the runner's own on this machine and UTC on a sandbox
assert.equal(parseTs("2026-11-11T10:00:00+07:00", localHost), Date.parse("2026-11-11T03:00:00Z"), "an offset is used as written");
assert.equal(parseTs("2026-11-11T10:00:00", { ...localHost }), Date.parse("2026-11-11T10:00:00Z"), "a naive time on another host is UTC");
assert.equal(parseTs("2026-11-11T10:00:00", localHost), new Date(2026, 10, 11, 10).getTime(), "and local on this machine");

const KEY = `SLG-${Date.now() % 1_000_000}`;
const SESSION = `lead-${KEY}`;
const DECOY = `decoy-${KEY}`;
const [S2, S3] = [`lead2-${KEY}`, `lead3-${KEY}`];
const sessions = [SESSION, DECOY, S2, S3];
const root = mkdtempSync(join(tmpdir(), "sstack-lineage-"));
const worktree = join(root, "worktree");
const claudeDir = join(root, "claude");
const codexHome = join(root, "codex");
const claudeChild = join(claudeDir, "child-uuid.jsonl");
ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);

const agentsWhere = (where: SQL) => db.select().from(agents).where(where).orderBy(asc(agents.agent_id));
const rowsOf = () => agentsWhere(eq(agents.session_id, SESSION));
const clear = () => db.delete(agents).where(eq(agents.session_id, SESSION));
const runRow = async () => (await db.select().from(runs).where(eq(runs.session_id, SESSION)))[0]!;
type Agent = typeof agents.$inferSelect;
const tokensOf = (r: Agent) => [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens].join();

try {
  mkdirSync(join(worktree, ".sstack/runs"), { recursive: true });
  cpSync(join(FIXTURES, "index.jsonl"), join(worktree, ".sstack/runs/index.jsonl"));
  // The lead's own transcript, a decoy session's that ends closer to the child's end, and the child's.
  mkdirSync(claudeDir);
  const usageLine = (id: string, input: number) =>
    JSON.stringify({ type: "assistant", message: { id, model: "claude-opus-5-5", usage: { input_tokens: input, output_tokens: 1 } } });
  writeFileSync(join(claudeDir, `${SESSION}.jsonl`), usageLine("l1", 1));
  writeFileSync(join(claudeDir, `${DECOY}.jsonl`), usageLine("d1", 999_999));
  writeFileSync(
    claudeChild,
    readFileSync(join(FIXTURES, "claude/child.jsonl"), "utf8").replace("__START__", new Date(startOf(implement) + 1000).toISOString()),
  );
  utimesSync(claudeChild, new Date(endOf(implement) - 5000), new Date(endOf(implement) - 5000));
  utimesSync(join(claudeDir, `${DECOY}.jsonl`), new Date(endOf(implement)), new Date(endOf(implement)));
  // The codex child's rollout, started when its line says, in the worktree.
  cpSync(join(FIXTURES, "codex"), codexHome, { recursive: true });
  const day = join(codexHome, "sessions/2026/11/11");
  const rollout = join(day, readdirSync(day)[0]!);
  writeFileSync(
    rollout,
    readFileSync(rollout, "utf8")
      .replaceAll("__START__", new Date(startOf(review)).toISOString())
      .replaceAll("__WORKTREE__", worktree),
  );
  process.env.CODEX_HOME = codexHome;

  await db.insert(jobs).values(linearJob(`sstack-lineage-${KEY}`, KEY, { machine_id: TEST_MACHINE_ID, stage: "implementing" }));
  const lead = {
    ...usageRun(KEY),
    session_id: SESSION,
    cwd: worktree,
    transcript_path: join(claudeDir, `${SESSION}.jsonl`),
    started_at: new Date(startOf(implement) - 600_000),
  };
  await db.insert(runs).values(lead);
  // Another run's session, so its transcript is not a child's.
  await db.insert(runs).values({ ...usageRun(KEY), session_id: DECOY, job_key: null, branch: null });

  await reconcileUsage({ only: [KEY] });
  const rows = await rowsOf();
  const id = (l: { run_dir: string }, harnessModel: string) => `sstack:${l.run_dir}#${harnessModel}@${KEY}`;
  assert.deepEqual(
    rows.map((r) => [r.agent_id, r.role, r.harness, r.status, r.model]),
    [
      [id(implement, "claude/haiku"), "implement", "claude", "completed", "claude-haiku-5-5"],
      [id(review, "codex/gpt-6-luna"), "review", "codex", "completed", "gpt-6-luna"],
      [id(pi, "pi/some-pi-model"), "implement", "pi", "failed", "some-pi-model"],
    ],
    "three children, the garbled line skipped, a priced model id from the transcript replacing the alias",
  );
  const spans = rows.map((r) => [r.ended_at!.getTime(), r.ended_at!.getTime() - r.started_at.getTime()]);
  const wanted = [implement, review, pi].map((l) => [endOf(l), Math.round(l.secs * 1000)]);
  assert.deepEqual(spans, wanted, "ended_at is the line's ts, the duration its secs");
  const [claude, codex, piRow] = rows as [Agent, Agent, Agent];
  const u = sumUsage(readFileSync(join(FIXTURES, "claude/child.jsonl"), "utf8"));
  assert.equal(tokensOf(claude), [u.input, u.output, u.cacheRead, u.cacheWrite].join(), "the claude child's transcript, not the decoy's");
  const r = parseRollout(readFileSync(rollout, "utf8"))!.usage;
  assert.equal(tokensOf(codex), [r.input, r.output, r.cacheRead, r.cacheWrite].join(), "the codex child's rollout");
  assert.equal(hasTokens(piRow), false, "a pi child has no tokens: its cost is unknown");

  await recordSstackLineage(await runRow(), localHost);
  assert.deepEqual(await rowsOf(), rows, "a second read changes nothing");

  const [leadCost, claudeCost, codexCost] = [costUsd(await runRow(), lead.model), costUsd(claude, claude.model), costUsd(codex, codex.model)];
  assert.ok(claudeCost > 0 && codexCost > 0, "both have a price");
  assert.ok(Math.abs((await branchSpend(db, [lead.branch!]))[lead.branch!]! - (leadCost + claudeCost + codexCost)) < 1e-12, "lead plus both children");

  await db
    .update(agents)
    .set({ input_tokens: claude.input_tokens + 1000 })
    .where(eq(agents.agent_id, claude.agent_id!));
  await recordSstackLineage(await runRow(), localHost);
  assert.equal((await rowsOf())[0]!.input_tokens, claude.input_tokens + 1000, "a read never lowers a recorded count");

  // A finished run does not claim a child dispatched after it ended.
  await clear();
  await recordSstackLineage({ ...(await runRow()), status: "ended", last_event_at: new Date(endOf(review) + 1000) }, localHost);
  assert.equal((await rowsOf()).length, 2, "the pi child is not claimed");
  await clear();

  // A child that ended before the run opened is an old one's.
  await recordSstackLineage({ ...(await runRow()), started_at: new Date(endOf(pi) + 3_600_000) }, localHost);
  assert.equal((await rowsOf()).length, 0, "children from before the run are skipped");

  // With no transcript or rollout the children are recorded with no tokens, so their cost is unknown.
  rmSync(claudeChild);
  rmSync(rollout);
  await reconcileUsage({ only: [KEY] });
  const bare = await rowsOf();
  assert.equal(bare.map((a) => `${a.model}:${hasTokens(a)}`).join(), "haiku:false,gpt-6-luna:false,some-pi-model:false", "the line's model, no tokens");
  assert.ok(Math.abs((await branchSpend(db, [lead.branch!]))[lead.branch!]! - leadCost) < 1e-12, "only the lead is counted");

  // Two jobs sharing a run_dir, and a panel (codex and claude, one run_dir), each get their own rows.
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = endOf(implement);
  const child = (l: object) => ({ ts: iso(T), role: "review", exit: 0, secs: 60, harness: "claude", model: "haiku", run_dir: implement.run_dir, ...l });
  const [wt2, wt3, dir3] = ["wt2", "wt3", "claude3"].map((n) => join(root, n));
  const writeIndex = (wt: string, children: object[]) => {
    mkdirSync(join(wt, ".sstack/runs"), { recursive: true });
    writeFileSync(join(wt, ".sstack/runs/index.jsonl"), children.map((c) => JSON.stringify(c)).join("\n"));
  };
  const runOf = (session_id: string, cwd: string, transcript_path?: string) => ({
    ...usageRun(KEY),
    session_id,
    job_key: `${KEY}-${session_id}`,
    branch: null,
    cwd,
    transcript_path,
    started_at: new Date(T - 3_600_000),
  });
  const [run2, run3] = await db
    .insert(runs)
    .values([runOf(S2, wt2), runOf(S3, wt3, join(dir3, "lead.jsonl"))])
    .returning();
  writeIndex(wt2, [child({ variant: "x" }), child({ variant: "y" }), child({ harness: "codex", model: "gpt-6-luna" })]);
  await recordSstackLineage(run2!, localHost);
  const same = await agentsWhere(like(agents.agent_id, `sstack:${implement.run_dir}#%${KEY}%`));
  assert.equal(same.length, 4, "the first job's child and the panel's three members (two variants) are separate rows");

  // Overlapping claude children each get their own transcript, though B starts nearer A's first line and ends first.
  mkdirSync(dir3);
  const put = (name: string, first: number, input: number, mtime: number) => {
    const file = join(dir3, `${name}.jsonl`);
    writeFileSync(file, `${JSON.stringify({ type: "user", timestamp: iso(first) })}\n${usageLine(`m${input}`, input)}`);
    utimesSync(file, new Date(mtime), new Date(mtime));
  };
  put("a", T + 30_000, 100, T + 100_000);
  put("b", T + 60_000, 200, T + 90_000);
  writeIndex(wt3, [child({ ts: iso(T + 100_000), secs: 100, run_dir: "A" }), child({ ts: iso(T + 90_000), secs: 70, run_dir: "B" })]);
  await recordSstackLineage(run3!, localHost);
  const overlapped = await agentsWhere(eq(agents.session_id, S3));
  assert.equal(overlapped.map((a) => a.input_tokens).join(), "100,200", "A has its transcript, B its");

  // A bad line (secs 1e17), a child started before the run (an older job's, though it ended after) and a read error.
  writeIndex(wt2, [child({ secs: 1e17, run_dir: "bad" }), child({ run_dir: "good", harness: "pi", model: "x" }), child({ secs: 600, run_dir: "old" })]);
  await recordSstackLineage({ ...run2!, started_at: new Date(T - 60_000) }, localHost);
  const ids = (await agentsWhere(eq(agents.session_id, S2))).map((a) => a.agent_id!.split("#")[0]);
  assert.deepEqual([ids.includes("sstack:good"), ids.includes("sstack:bad"), ids.includes("sstack:old")], [true, false, false]);
  await recordSstackLineage(run2!, { ...localHost, readFile: () => Promise.reject(new Error("EACCES")) });
  await assert.rejects(recordSstackLineage(run2!, { ...localHost, readFile: () => Promise.reject(new HostGoneError("gone")) }), HostGoneError);

  console.log("sstack lineage regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(agents).where(inArray(agents.session_id, sessions));
  await db.delete(runs).where(inArray(runs.session_id, sessions));
  await db.delete(events).where(inArray(events.session_id, sessions));
  await db.delete(jobs).where(eq(jobs.id, jobId("linear", `sstack-lineage-${KEY}`)));
  rmSync(root, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
