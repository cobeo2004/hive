import { basename, dirname } from "node:path";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, runs, type RunRow } from "../db/schema";
import { readRollouts } from "../lib/codex-usage";
import { isMcpSession } from "../lib/factory";
import { HostAsleepError, HostGoneError, localHost, type JobHost } from "../lib/host";
import type { Usage } from "../lib/events";
import { nativeSessionOf } from "../lib/t3-client";
import { sumUsage, transcriptPathFor } from "../lib/transcript";
import { codexHomeOf } from "./codex-usage";

// sstack logs each ended child it dispatched to <worktree>/.sstack/runs/index.jsonl. Each line becomes an `agents` row `sstack:<run_dir>#<harness>/<model>[#<variant>]@<job>`
// (R19/Q31): a panel's members and jobs share a run_dir, so those make the id unique. Its cost is read from the session sstack records on the line
// (`session: {id, kind}`), never matched by time or text: no session, a pi/other child or an id nothing answers to has no tokens ("—").

const SLACK_MS = 2 * 60_000;
const SAFE_ID = /^[A-Za-z0-9-]{8,64}$/;

const sessionOf = z.object({ id: z.string().min(1).max(200), kind: z.string() });
const line = z.object({
  ts: z.string(),
  role: z.string(),
  harness: z.string(),
  model: z.string(),
  exit: z.number().nullish(),
  secs: z.number().nonnegative(),
  run_dir: z.string().min(1),
  variant: z.string().nullish(),
  session: sessionOf.nullish().catch(undefined), // a malformed one is no session, not a skipped line
});

/** `ts` is naive in real sstack: this machine's clock locally, UTC in a sandbox. An offset is used as written. */
export const parseTs = (ts: string, host: JobHost) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(ts) || host === localHost ? ts : `${ts}Z`);

type Own = { child: z.infer<typeof line>; start: number; end: number };

/** Each child's usage by its session id: one `find` for every Claude transcript, one rollout read for every Codex thread. Ids a `runs` row owns are not a child's. */
async function usageOf(run: RunRow, host: JobHost, own: Own[]) {
  const ids = new Map<Own, string>();
  for (const o of own) {
    // The recorded id itself (claude, codex) or, for a T3 thread, the provider session T3 says it ran. Null is "—".
    const { session: s, harness } = o.child;
    let id: string | null = null;
    if (s && (harness === "claude" || harness === "codex")) id = s.kind === "t3-thread" ? await nativeSessionOf(host, s.id) : s.kind === harness ? s.id : null;
    if (id && SAFE_ID.test(id)) ids.set(o, id);
  }
  const all = [...ids.values()];
  const taken = new Set(all.length ? (await db.select({ id: runs.session_id }).from(runs).where(inArray(runs.session_id, all))).map((r) => r.id) : []);
  const want = (harness: string) => [...ids].filter(([o, id]) => o.child.harness === harness && !taken.has(id));
  const usage = new Map<string, Usage>();
  const [claude, lead] = [want("claude"), transcriptPathFor(run)];
  if (claude.length && lead) {
    const names = claude.flatMap(([, id], i) => [...(i ? ["-o"] : []), "-name", `${id}.jsonl`]);
    const args = ["-c", 'find "$@" 2>/dev/null; true', "sh", dirname(dirname(lead)), "-maxdepth", "2", "(", ...names, ")"];
    for (const path of (await host.run("sh", args, { timeoutMs: 60_000 })).stdout.split("\n").filter(Boolean))
      usage.set(basename(path, ".jsonl"), sumUsage((await host.readFile(path)) ?? ""));
  }
  // An `mcp:` lead already counts its codex children.
  const codex = isMcpSession(run.session_id) ? [] : want("codex");
  if (codex.length) {
    const rollouts = await readRollouts(host, codexHomeOf(host), Math.min(...codex.map(([o]) => o.start)));
    for (const r of rollouts) if (codex.some(([, id]) => id === r.threadId)) usage.set(r.threadId, r.usage);
  }
  return new Map(own.flatMap((o) => ((usage.get(ids.get(o)!)?.model ?? "unknown") === "unknown" ? [] : [[o, usage.get(ids.get(o)!)!] as const])));
}

/** Upserts one agents row per child sstack logged for this run's worktree, with its cost where it can be read. */
export async function recordSstackLineage(run: RunRow, host: JobHost) {
  if (!run.cwd) return;
  try {
    const text = await host.readFile(`${run.cwd}/.sstack/runs/index.jsonl`);
    if (text === null) return;
    const children: Own[] = [];
    for (const raw of text.split("\n")) {
      try {
        const child = line.parse(JSON.parse(raw));
        const end = parseTs(child.ts, host);
        children.push({ child, start: end - Math.round(child.secs * 1000), end });
      } catch {} // a garbled line
    }
    // No bad time reaches the insert; no child started before the run (an earlier job's: reused worktree, committed
    // index.jsonl) or, for a finished run (its last event is its end), ended after it.
    const after = run.started_at.getTime() - SLACK_MS;
    const before = run.status === "ended" ? run.last_event_at.getTime() + SLACK_MS : Infinity;
    const own = children
      .filter(({ start, end }) => [start, end].every((ms) => Math.abs(ms) <= 8.64e15) && start >= after && end <= before)
      .sort((a, b) => a.start - b.start);
    const reads = await usageOf(run, host, own);
    for (const o of own) {
      const { child, start, end } = o;
      // No match (no session, no transcript or rollout, no usage or no model) keeps what was stored.
      const found = reads.get(o);
      const model = found?.model ?? child.model;
      const id = `sstack:${child.run_dir}#${child.harness}/${child.model}${child.variant ? `#${child.variant}` : ""}@${run.job_key ?? run.session_id}`;
      const tokens = {
        input_tokens: found?.input ?? 0,
        output_tokens: found?.output ?? 0,
        cache_read_tokens: found?.cacheRead ?? 0,
        cache_write_tokens: found?.cacheWrite ?? 0,
      };
      const fixed = {
        subagent_type: child.role,
        role: child.role,
        harness: child.harness,
        status: child.exit === 0 ? ("completed" as const) : ("failed" as const),
        started_at: new Date(start),
        ended_at: new Date(end),
      };
      await db
        .insert(agents)
        .values({ tool_use_id: id, agent_id: id, session_id: run.session_id, model, ...fixed, ...tokens })
        .onConflictDoUpdate({
          target: agents.tool_use_id,
          // A match replaces tokens and model (a corrected match corrects spend); no match keeps what was read. session_id stays with the first claimant.
          set: { ...fixed, ...(found && { ...tokens, model }) },
        });
    }
  } catch (error) {
    if (error instanceof HostGoneError || error instanceof HostAsleepError) throw error;
    // Lineage is a side view: whatever goes wrong here must never stop the usage reconcile behind it.
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "sstack-lineage:skipped", key: run.job_key, reason: String(error) }));
  }
}
