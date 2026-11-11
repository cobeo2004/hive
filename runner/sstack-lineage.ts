import { basename, dirname } from "node:path";
import { inArray } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { agents, runs, type RunRow } from "../db/schema";
import { parseRollout } from "../lib/codex-usage";
import { isMcpSession } from "../lib/factory";
import { HostAsleepError, HostGoneError, localHost, type JobHost } from "../lib/host";
import type { Usage } from "../lib/events";
import { sumUsage, transcriptPathFor } from "../lib/transcript";
import { codexHomeOf } from "./codex-usage";

// sstack logs each ended child it dispatched to <worktree>/.sstack/runs/index.jsonl. Each line becomes an `agents` row `sstack:<run_dir>#<harness>/<model>[#<variant>]@<job>`
// (R19/Q31): a panel's members and jobs share a run_dir, so those make the id unique. Its cost is read from the child's own Claude transcript or
// Codex rollout when exactly one is found; the rest has no tokens. A codex lead's codex child also shows as its `codex:<thread>` row, which counts its cost.

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

// sstack's task text is "Read the brief at <worktree>/<run_dir>/brief.skills.md". A child's transcript or rollout is the one whose
// prompt (the user text before the first reply: Codex puts AGENTS.md first) names that absolute path, in whichever worktree it ran.
type Own = { child: z.infer<typeof line>; start: number; end: number };
// The files at most `$2` deep under `$1` (a Claude subagent's are deeper), written to in the last `$3` minutes, naming any `-e` needle.
const NAMED = `r=$1 d=$2 m=$3; shift 3; find "$r" -maxdepth "$d" -name '*.jsonl' -mmin "-$m" -exec grep -lF "$@" {} + 2>/dev/null; true`;

function promptOf(text: string) {
  let prompt = "";
  for (const raw of text.split("\n")) {
    try {
      const o = JSON.parse(raw);
      const role = o.type === "response_item" ? o.payload?.role : o.type;
      if (role === "assistant") break;
      const c = role === "user" ? (o.message ?? o.payload)?.content : "";
      prompt += typeof c === "string" ? c : Array.isArray(c) ? c.map((p) => p?.text ?? "").join("\n") : "";
    } catch {} // not json
  }
  return prompt;
}

/** Each child's usage, only where exactly one file names it, with its model, and that file names no other child: ambiguity is no match. */
async function usageOf(run: RunRow, host: JobHost, kids: Own[], harness: "claude" | "codex", root: string | undefined, depth: string, skip?: string) {
  const needle = (o: Own) => `${run.cwd!.replace(/\/$/, "")}/${o.child.run_dir}/brief`;
  if (!kids.length || !root) return new Map<Own, Usage>();
  const minutes = String(Math.max(1, Math.ceil((Date.now() - Math.min(...kids.map((k) => k.start)) + SLACK_MS) / 60_000)));
  const args = ["-c", NAMED, "sh", root, depth, minutes, ...kids.flatMap((k) => ["-e", needle(k)])];
  const paths = (await host.run("sh", args, { timeoutMs: 60_000 })).stdout.split("\n").filter((p) => p && p !== skip);
  const files = [];
  for (const path of paths) {
    const text = (await host.readFile(path)) ?? "";
    const roll = harness === "codex" ? parseRollout(text) : undefined;
    const id = roll ? (roll.threadId === roll.sessionId ? roll.threadId : "") : basename(path, ".jsonl");
    files.push({ path, id, prompt: promptOf(text), usage: roll ? roll.usage : sumUsage(text) });
  }
  const ids = files.map((f) => f.id);
  const owned = new Set(ids.length ? (await db.select({ id: runs.session_id }).from(runs).where(inArray(runs.session_id, ids))).map((o) => o.id) : []);
  const live = files.filter((f) => f.id && f.usage.model !== "unknown" && !owned.has(f.id));
  // The index records aliases such as `haiku`; the transcript names the real model.
  const fit = (k: Own, m: string) => (harness === "codex" ? m === k.child.model : m.includes(k.child.model));
  const fits = new Map(kids.map((k) => [k, live.filter((f) => f.prompt.includes(needle(k)) && fit(k, f.usage.model))]));
  const all = [...fits.values()].flat();
  const once = (k: Own) => fits.get(k)!.length === 1 && all.filter((f) => f === fits.get(k)![0]).length === 1;
  return new Map(kids.filter(once).map((k) => [k, fits.get(k)![0]!.usage] as const));
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
    const lead = transcriptPathFor(run);
    const of = (h: string) => own.filter((c) => c.child.harness === h);
    // Every worktree's transcripts sit side by side under the projects root; an `mcp:` lead already counts its codex children.
    const reads = new Map([
      ...(await usageOf(run, host, of("claude"), "claude", lead && dirname(dirname(lead)), "2", lead)),
      ...(await usageOf(run, host, isMcpSession(run.session_id) ? [] : of("codex"), "codex", `${codexHomeOf(host)}/sessions`, "4")),
    ]);
    for (const o of own) {
      const { child, start, end } = o;
      // No match (none, several, no usage or no model) keeps what was stored.
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
