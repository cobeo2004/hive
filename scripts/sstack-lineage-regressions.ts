import "./test-guard";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { asc, eq, inArray, like, type SQL } from "drizzle-orm";

const { db } = await import("../db/client");
const { agents, events, jobs, runs } = await import("../db/schema");
const { linearJob, usageRun } = await import("./fixtures");
const { jobId } = await import("../lib/sources/shapes");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { eventSchema } = await import("../lib/events");
const { attemptBranch } = await import("../lib/factory");
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
const [S2, S3] = [`lead2-${KEY}`, `lead3-${KEY}`];
const sessions = [SESSION, S2, S3];
const root = mkdtempSync(join(tmpdir(), "sstack-lineage-"));
const worktree = join(root, "worktree");
const claudeDir = join(root, "projects/lead");
const codexHome = join(root, "codex");
const CLAUDE_ID = "child-uuid-0000-claude-1";
const claudeChild = join(claudeDir, `${CLAUDE_ID}.jsonl`);
ingestClient.post = async (event) => ingest(db, [eventSchema.parse(event)]);
// No test reads T3's real state DB: sqlite3 is answered here (its output, or a throw), counted per call.
const sqlite = { calls: [] as string[], answer: async () => "" };
const realRun = localHost.run;
localHost.run = async (command, args, options) => {
  if (command !== "sqlite3") return realRun.call(localHost, command, args, options);
  sqlite.calls.push(args.at(-1)!);
  return { stdout: await sqlite.answer(), stderr: "" };
};
process.env.T3CODE_HOME = root;

const agentsWhere = (where: SQL) => db.select().from(agents).where(where).orderBy(asc(agents.agent_id));
const rowsOf = () => agentsWhere(eq(agents.session_id, SESSION));
const clear = () => db.delete(agents).where(eq(agents.session_id, SESSION));
const runRow = async () => (await db.select().from(runs).where(eq(runs.session_id, SESSION)))[0]!;
type Agent = typeof agents.$inferSelect;
const tokensOf = (r: Agent) => [r.input_tokens, r.output_tokens, r.cache_read_tokens, r.cache_write_tokens].join();

try {
  mkdirSync(join(worktree, ".sstack/runs"), { recursive: true });
  cpSync(join(FIXTURES, "index.jsonl"), join(worktree, ".sstack/runs/index.jsonl"));
  // The lead's own transcript, a sibling of the child's (same time, same model, huge) and the child's.
  mkdirSync(claudeDir, { recursive: true });
  const usageLine = (id: string, input: number, model = "claude-opus-5-5") =>
    JSON.stringify({ type: "assistant", message: { id, model, usage: { input_tokens: input, output_tokens: 1 } } });
  const leadPath = join(claudeDir, `${SESSION}.jsonl`);
  writeFileSync(leadPath, usageLine("l1", 1));
  writeFileSync(join(claudeDir, "sibling-uuid-0000-claude-2.jsonl"), usageLine("s1", 999_999, "claude-haiku-5-5"));
  cpSync(join(FIXTURES, `claude/${CLAUDE_ID}.jsonl`), claudeChild);
  cpSync(join(FIXTURES, "codex"), codexHome, { recursive: true });
  const day = join(codexHome, "sessions/2026/11/11");
  const text = readFileSync(join(day, readdirSync(day)[0]!), "utf8");
  process.env.CODEX_HOME = codexHome;

  await db.insert(jobs).values(linearJob(`sstack-lineage-${KEY}`, KEY, { machine_id: TEST_MACHINE_ID, stage: "implementing" }));
  const lead = { ...usageRun(KEY), session_id: SESSION, cwd: worktree, transcript_path: leadPath, started_at: new Date(startOf(implement) - 600_000) };
  await db.insert(runs).values(lead);

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
  const u = sumUsage(readFileSync(claudeChild, "utf8"));
  assert.equal(tokensOf(claude), [u.input, u.output, u.cacheRead, u.cacheWrite].join(), "the transcript the session id names, not its sibling");
  const r = parseRollout(text)!.usage;
  assert.equal(tokensOf(codex), [r.input, r.output, r.cacheRead, r.cacheWrite].join(), "the rollout whose thread id the line names");
  assert.equal(hasTokens(piRow), false, "a pi child has no session: its cost is unknown");

  await recordSstackLineage(await runRow(), localHost);
  assert.deepEqual(await rowsOf(), rows, "a second read changes nothing");

  const [leadCost, claudeCost, codexCost] = [costUsd(await runRow(), lead.model), costUsd(claude, claude.model), costUsd(codex, codex.model)];
  assert.ok(claudeCost > 0 && codexCost > 0, "both have a price");
  assert.ok(Math.abs((await branchSpend(db, [lead.branch!]))[lead.branch!]! - (leadCost + claudeCost + codexCost)) < 1e-12, "lead plus both children");

  // A finished run does not claim a child dispatched after it ended.
  await clear();
  await recordSstackLineage({ ...(await runRow()), status: "ended", last_event_at: new Date(endOf(review) + 1000) }, localHost);
  assert.equal((await rowsOf()).length, 2, "the pi child is not claimed");

  // Two jobs sharing a run_dir, and a panel (codex and claude, one run_dir), each get their own rows.
  const iso = (ms: number) => new Date(ms).toISOString();
  const T = endOf(implement);
  const child = (l: object) => ({ ts: iso(T), role: "review", exit: 0, secs: 60, harness: "claude", model: "haiku", run_dir: implement.run_dir, ...l });
  const [wt2, wt3, dir3, other] = ["wt2", "wt3", "projects/lead3", "projects/other"].map((n) => join(root, n));
  const writeIndex = (wt: string, children: object[]) => {
    mkdirSync(join(wt, ".sstack/runs"), { recursive: true });
    writeFileSync(join(wt, ".sstack/runs/index.jsonl"), children.map((c) => (typeof c === "string" ? c : JSON.stringify(c))).join("\n"));
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
    .values([runOf(S2, wt2), { ...runOf(S3, wt3, join(dir3, "lead.jsonl")), branch: attemptBranch(KEY, 3) }])
    .returning();
  writeIndex(wt2, [child({ variant: "x" }), child({ variant: "y" }), child({ harness: "codex", model: "gpt-6-luna" })]);
  await recordSstackLineage(run2!, localHost);
  const same = await agentsWhere(like(agents.agent_id, `sstack:${implement.run_dir}#%${KEY}%`));
  assert.equal(same.length, 4, "the first job's child and the panel's three members (two variants) are separate rows");

  for (const d of [dir3, other]) mkdirSync(d, { recursive: true });
  writeFileSync(join(dir3, "lead.jsonl"), usageLine("l", 7, "claude-haiku-5-5"));
  const put = (name: string, input: number, model = "claude-haiku-5-5") => writeFileSync(join(other, `${name}.jsonl`), usageLine(`m${input}`, input, model));
  const session = (id: string, kind = "claude") => ({ session: { id, kind } });
  const tick = async (...lines: object[]) => {
    writeIndex(wt3, lines);
    await recordSstackLineage(run3!, localHost);
    return (await agentsWhere(eq(agents.session_id, S3))).map((a) => a.input_tokens).join();
  };
  const [A, B] = ["aaaaaaaa-0000-claude", "bbbbbbbb-0000-claude"];
  const [lineA, lineB] = [child({ run_dir: "r/P", variant: "x", ...session(A) }), child({ run_dir: "r/P", variant: "y", ...session(B) })];
  put("zzzzzzzz-0000-claude", 999_999);
  put(A, 1000);
  assert.equal(await tick(lineA, lineB), "1000,0", "B has no transcript yet: unknown, A's is not B's");
  put(B, 200);
  assert.equal(await tick(lineA, lineB), "1000,200", "each member gets its own session's transcript");

  // No transcript for a session keeps the stored tokens; a match replaces them.
  rmSync(join(other, `${A}.jsonl`));
  assert.equal(await tick(lineA, lineB), "1000,200", "a transcript gone keeps the tokens");
  put(A, 1100);
  assert.equal(await tick(lineA, lineB), "1100,200", "a match replaces the stored tokens");

  await db.delete(agents).where(eq(agents.session_id, S3));
  assert.equal(await tick({ ...lineA, session: undefined }, { ...lineB, session: null }), "0,0", "no session, no tokens (their transcripts exist)");

  // A T3 child is costed from the session its thread ran (T3's state names it): one sqlite call each.
  const t3 = child({ run_dir: "r/T", ...session("thread:delegated:abc%3A1", "t3-thread") });
  const native = (nativeId: string) => JSON.stringify({ driver: "claudeAgent", nativeId, strength: "strong" });
  await db.delete(agents).where(eq(agents.session_id, S3));
  sqlite.answer = async () => native(B);
  assert.equal(await tick(t3), "200", "the thread's native session's transcript");
  assert.ok(sqlite.calls.length === 1 && sqlite.calls[0]!.includes("thread_id='thread:delegated:abc%3A1'"), "one lookup, for that thread");
  await tick(child({ run_dir: "r/T", ...session("x';drop table t;--", "t3-thread") }));
  assert.equal(sqlite.calls.length, 1, "an id outside the charset never reaches sqlite");

  // Unknown or unresolvable: no tokens, the stored ones kept, nothing thrown. A host that is gone is not unknown.
  for (const answer of ["", "not json", native("../etc/x")]) {
    sqlite.answer = async () => answer;
    assert.equal(await tick(t3), "200", "an unanswered T3 lookup keeps the tokens");
  }
  sqlite.answer = () => Promise.reject(new Error("no such table"));
  assert.equal(await tick(t3), "200", "so does one that fails");
  await db.delete(agents).where(eq(agents.session_id, S3));
  const odd = [...["pi", "other", "codex"].map((k) => session(A, k)), session(SESSION), { session: { id: 5 } }];
  assert.equal(
    await tick(...odd.map((o, n) => child({ run_dir: `r/${n}`, ...o }))),
    "0,0,0,0,0",
    "pi, other, a wrong kind, the lead's own, a malformed session",
  );
  sqlite.answer = () => Promise.reject(new HostGoneError("gone"));
  writeIndex(wt3, [t3]);
  await assert.rejects(recordSstackLineage(run3!, localHost), HostGoneError);

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
  localHost.run = realRun;
  await db.delete(agents).where(inArray(agents.session_id, sessions));
  await db.delete(runs).where(inArray(runs.session_id, sessions));
  await db.delete(events).where(inArray(events.session_id, sessions));
  await db.delete(jobs).where(eq(jobs.id, jobId("linear", `sstack-lineage-${KEY}`)));
  rmSync(root, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
