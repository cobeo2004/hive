import { basename, dirname, join } from "node:path";
import { inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, runs, type RunRow } from "../db/schema";
import { readRollouts, type Rollout } from "../lib/codex-usage";
import { isMcpSession } from "../lib/factory";
import { HostAsleepError, HostGoneError, localHost, type JobHost } from "../lib/host";
import { sumUsage, transcriptPathFor } from "../lib/transcript";
import { codexHomeOf } from "./codex-usage";

// sstack logs every child it dispatches to <worktree>/.sstack/runs/index.jsonl, once the child has
// ended. Each line becomes an `agents` row `sstack:<run_dir>#<harness>/<model>[#<variant>]@<job>` (R19/Q31): a run_dir
// is shared by a panel's members and by jobs, so those make the id unique. Its cost is read from the child's
// own Claude transcript or Codex rollout when one can be found; the rest has no tokens. A codex lead's codex child
// also shows as its `codex:<thread>` row, which counts its cost.

const SLACK_MS = 2 * 60_000;

const line = z.object({
  ts: z.string(),
  role: z.string(),
  harness: z.string(),
  model: z.string(),
  exit: z.number().nullish(),
  secs: z.number().nonnegative(),
  run_dir: z.string().min(1),
  variant: z.string().nullish(),
});

/** `ts` is naive in real sstack: this machine's clock locally, UTC in a sandbox. An offset is used as written. */
export const parseTs = (ts: string, host: JobHost) => Date.parse(/(Z|[+-]\d\d:?\d\d)$/.test(ts) || host === localHost ? ts : `${ts}Z`);

const closest = <T>(items: T[], gap: (t: T) => number) => items.sort((a, b) => gap(a) - gap(b))[0];

/** The Claude transcripts next to the lead's, minus the lead's and any other run's session. */
async function claudeFiles(run: RunRow, host: JobHost) {
  const lead = transcriptPathFor(run);
  if (!lead || !(await host.exists(dirname(lead)))) return [];
  const ids = (await host.list(dirname(lead))).filter((n) => n.endsWith(".jsonl") && n !== basename(lead)).map((n) => n.slice(0, -".jsonl".length));
  const owned = ids.length ? await db.select({ id: runs.session_id }).from(runs).where(inArray(runs.session_id, ids)) : [];
  return Promise.all(
    ids
      .filter((id) => !owned.some((o) => o.id === id))
      .map(async (id) => {
        const path = join(dirname(lead), `${id}.jsonl`);
        let text: Promise<string | null> | undefined;
        return { id, mtime: await host.mtimeMs(path), text: () => (text ??= host.readFile(path)) };
      }),
  );
}

/** The unclaimed transcript written during the child whose first timestamp is nearest its start (children go in start order). */
async function claudeUsage(files: Awaited<ReturnType<typeof claudeFiles>>, [start, end]: [number, number], claimed: Set<string>) {
  const near = await Promise.all(
    files
      .filter((f) => f.mtime >= start && f.mtime <= end + SLACK_MS && !claimed.has(f.id))
      .map(async (f) => ({ f, gap: Math.abs(Date.parse(/"timestamp":"([^"]+)"/.exec((await f.text()) ?? "")?.[1] ?? "") - start) })),
  );
  const found = closest(
    near.filter((c) => c.gap <= SLACK_MS),
    (c) => c.gap,
  );
  if (!found) return undefined;
  claimed.add(found.f.id);
  return sumUsage((await found.f.text()) ?? "");
}

/** The root Codex thread started in the worktree when the child did. */
function codexUsage(run: RunRow, rollouts: Rollout[], [start, end]: [number, number], claimed: Set<string>) {
  const cwd = run.cwd!.replace(/\/$/, "");
  const found = closest(
    rollouts.filter(
      (r) =>
        r.threadId === r.sessionId &&
        !claimed.has(r.threadId) &&
        (r.cwd === cwd || r.cwd?.startsWith(`${cwd}/`)) &&
        r.startedAt !== null &&
        r.startedAt >= start - SLACK_MS &&
        r.startedAt <= end,
    ),
    (r) => Math.abs(r.startedAt! - start),
  );
  if (found) claimed.add(found.threadId);
  return found?.usage;
}

/** Upserts one agents row per child sstack logged for this run's worktree, with its cost where it can be read. */
export async function recordSstackLineage(run: RunRow, host: JobHost) {
  if (!run.cwd) return;
  try {
    const text = await host.readFile(`${run.cwd}/.sstack/runs/index.jsonl`);
    if (text === null) return;
    const children: { child: z.infer<typeof line>; start: number; end: number }[] = [];
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
    const claimed = new Set<string>();
    // Rollouts are read once, from the earliest codex child's start (Infinity when there is none); an `mcp:` lead already counts its own.
    const from = Math.min(...own.filter((c) => c.child.harness === "codex").map((c) => c.start)) - SLACK_MS;
    const rollouts = from === Infinity || isMcpSession(run.session_id) ? [] : await readRollouts(host, codexHomeOf(host), from);
    const files = own.some((c) => c.child.harness === "claude") ? await claudeFiles(run, host) : [];
    for (const { child, start, end } of own) {
      const found =
        child.harness === "claude"
          ? await claudeUsage(files, [start, end], claimed)
          : child.harness === "codex"
            ? codexUsage(run, rollouts, [start, end], claimed)
            : undefined;
      // The index records aliases such as `haiku`, which have no price; the transcript names the real model.
      const resolved = found && found.model !== "unknown" ? found.model : undefined;
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
        .values({ tool_use_id: id, agent_id: id, session_id: run.session_id, model: resolved ?? child.model, ...fixed, ...tokens })
        .onConflictDoUpdate({
          target: agents.tool_use_id,
          // Tokens never go down, as in ingest; session_id stays with the first run to claim the child.
          set: {
            ...fixed,
            ...(resolved && { model: resolved }),
            ...Object.fromEntries(
              Object.keys(tokens).map((c) => [c, sql`greatest(${sql.identifier("agents")}.${sql.identifier(c)}, ${sql.raw(`excluded.${c}`)})`]),
            ),
          },
        });
    }
  } catch (error) {
    if (error instanceof HostGoneError || error instanceof HostAsleepError) throw error;
    // Lineage is a side view: whatever goes wrong here must never stop the usage reconcile behind it.
    console.log(JSON.stringify({ at: new Date().toISOString(), event: "sstack-lineage:skipped", key: run.job_key, reason: String(error) }));
  }
}
