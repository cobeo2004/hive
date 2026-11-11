import { and, desc, eq, isNull, lt } from "drizzle-orm";
import { z } from "zod";
import { db } from "../db/client";
import { accountUsage, agentAccounts, runs, type JobRow, type RunRow } from "../db/schema";
import { unseal } from "../lib/creds";
import { codexUsage, readRollouts, ROLLOUT_SLACK_MS, type Limits, type Rollout } from "../lib/codex-usage";
import { attemptBranch, isMcpSession } from "../lib/factory";
import type { RepoName } from "../lib/github/app";
import { github, type BranchPull } from "../lib/github/pulls";
import type { JobHost } from "../lib/host";
import { runnerEventId } from "../lib/stages";
import { transcriptPathFor, transcriptRateLimited } from "../lib/transcript";
import { forbidInTest } from "../lib/test-mode";
import { codexHomeOf } from "./codex-usage";
import { postEvent } from "./ingest-client";

// The 5h and 7d meters of each subscription account (R11a): Claude's are polled from Anthropic's
// OAuth usage endpoint, Codex's ride on the rollouts the runner already reads. API-key accounts
// have no windows, so they never get a row.

const CLAUDE_USAGE_URL = "https://api.anthropic.com/api/oauth/usage";

const log = (event: string, detail: Record<string, unknown>) => console.log(JSON.stringify({ at: new Date().toISOString(), event, ...detail }));

/** One row per window present; an older reading never replaces a newer row. */
export async function upsertUsage(accountId: string, limits: Limits, now = new Date()) {
  for (const [window, w] of Object.entries(limits) as [keyof Limits, NonNullable<Limits[keyof Limits]>][]) {
    const used_pct = Math.min(100, Math.max(0, w.usedPct));
    const resets_at = w.resetsAt === null ? null : new Date(w.resetsAt * 1000);
    await db
      .insert(accountUsage)
      .values({ account_id: accountId, window, used_pct, resets_at, read_at: now })
      .onConflictDoUpdate({
        target: [accountUsage.account_id, accountUsage.window],
        set: { used_pct, resets_at, read_at: now },
        setWhere: lt(accountUsage.read_at, now),
      });
  }
}

const claudeWindow = z.object({ utilization: z.number(), resets_at: z.string().nullish() }).nullish().catch(undefined);
const claudeBody = z.object({ five_hour: claudeWindow, seven_day: claudeWindow });

/** Claude's `/api/oauth/usage` body (utilization is a percent) as limits; a missing window is left out. */
export function claudeLimits(body: unknown): Limits {
  const parsed = claudeBody.safeParse(body);
  if (!parsed.success) return {};
  const limits: Limits = {};
  for (const [name, w] of [
    ["5h", parsed.data.five_hour],
    ["7d", parsed.data.seven_day],
  ] as const) {
    if (!w) continue;
    const resets = w.resets_at ? Date.parse(w.resets_at) : NaN;
    limits[name] = { usedPct: w.utilization, resetsAt: Number.isFinite(resets) ? resets / 1000 : null };
  }
  return limits;
}

type PollOptions = { fetch?: typeof fetch; env?: Record<string, string | undefined>; now?: Date };

const realFetch: typeof fetch = (input, init) => {
  forbidInTest("Anthropic usage API");
  return fetch(input, init);
};

/**
 * Reads the meters of every live Claude subscription account. A failed read is logged without the
 * token and leaves the account's rows as they were.
 */
export async function pollClaudeUsage({ fetch: get = realFetch, env = process.env, now = new Date() }: PollOptions = {}) {
  const accounts = await db
    .select({ id: agentAccounts.id, sealed: agentAccounts.sealed })
    .from(agentAccounts)
    .where(and(eq(agentAccounts.provider, "claude"), eq(agentAccounts.kind, "subscription"), isNull(agentAccounts.disconnected_at)));
  if (accounts.length === 0) return;
  const key = env.HIVE_CREDS_PRIVATE_KEY;
  if (!key) return log("account-usage:skipped", { reason: "HIVE_CREDS_PRIVATE_KEY is not set" });
  // ponytail: one account at a time; a pool of dozens would want a small concurrency.
  for (const { id, sealed } of accounts) {
    try {
      // The token lives only in this scope.
      const token = unseal(sealed, key);
      const res = await get(CLAUDE_USAGE_URL, {
        headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20", Accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!res.ok) {
        log("account-usage:failed", { account: id, reason: res.status });
        continue;
      }
      await upsertUsage(id, claudeLimits(await res.json()), now);
    } catch (error) {
      log("account-usage:failed", { account: id, reason: error instanceof Error ? error.name : "error" });
    }
  }
}

/** The newest limits reading among a run's rollouts (root and subagents), with when it was written. */
export function newestLimits(rollouts: readonly Pick<Rollout, "rateLimits" | "rateLimitsAt">[]) {
  let best: { limits: Limits; at: number } | undefined;
  for (const r of rollouts) {
    const at = r.rateLimitsAt;
    if (r.rateLimits && at !== undefined && Number.isFinite(at) && (!best || at > best.at)) best = { limits: r.rateLimits, at };
  }
  return best;
}

/**
 * A Codex run's limits, from its rollout (`at`: when it wrote them); only a subscription account has them.
 * A reading with no event time cannot be ordered against the stored row, so it is dropped.
 */
export async function recordCodexLimits(accountId: string, limits: Limits, at?: number) {
  if (at === undefined || !Number.isFinite(at)) return;
  const [account] = await db
    .select({ id: agentAccounts.id })
    .from(agentAccounts)
    .where(and(eq(agentAccounts.id, accountId), eq(agentAccounts.kind, "subscription")));
  if (account) await upsertUsage(accountId, limits, new Date(at));
}

/** The provider's structured record of a run (Claude transcript, Codex rollout): was it ended by a rate limit? Replaced in regressions. */
export const rateLimitRuntime = {
  async signal(run: RunRow, host: JobHost) {
    if (!isMcpSession(run.session_id)) {
      const path = transcriptPathFor(run);
      return !!path && transcriptRateLimited((await host.readFile(path)) ?? "");
    }
    const startedAt = run.started_at.getTime();
    const rollouts = await readRollouts(host, codexHomeOf(host), startedAt - ROLLOUT_SLACK_MS);
    return codexUsage(rollouts, { cwd: run.cwd, branch: run.branch, startedAt })?.main.rateLimited ?? false;
  },
};

/** R10a: did the provider rate-limit the job's current attempt? Anything unreadable is no, so a tick never breaks on it. */
export async function rateLimitedRun(job: { key: string; attempt: number }, host: JobHost) {
  try {
    const [run] = await db
      .select()
      .from(runs)
      .where(and(eq(runs.job_key, job.key), eq(runs.branch, attemptBranch(job.key, job.attempt))))
      .orderBy(desc(runs.started_at))
      .limit(1);
    return !!run && (await rateLimitRuntime.signal(run, host));
  } catch {
    return false;
  }
}

/** R10a: no account fallback once a PR exists (a relaunch could only open a second one): the job stays at pr with one note. Returns whether it posted. */
export async function holdAtPr(job: Pick<JobRow, "key" | "external_id" | "attempt" | "session_id" | "stage" | "stage_summary">, prUrl: string) {
  if (job.stage === "pr" && job.stage_summary?.startsWith("The account hit its rate limit")) return false;
  await postEvent({
    eventId: runnerEventId("inferred", job.external_id, job.attempt, "pr", "rate-limited"),
    sessionId: job.session_id ?? runnerEventId("inferred", job.external_id, job.attempt),
    at: Date.now(),
    kind: "stage",
    stage: "pr",
    jobKey: job.key,
    summary: `The account hit its rate limit, and Hive will not relaunch it now that ${prUrl} is open.`,
    prUrl,
  });
  return true;
}

/**
 * R10a: the one "does this job have a PR?" check behind all three no-fallback paths (watchdog, inferJob, relaunch). The stored
 * url counts as open; else the attempt branch's PR (`lookup`, so a caller that already started one shares it). A lookup that
 * throws propagates: the caller skips the job rather than treat "unknown" as "no PR" and relaunch it.
 */
export async function jobPr(
  job: Pick<JobRow, "key" | "attempt" | "repo" | "pr_url">,
  lookup: () => Promise<BranchPull | null> = () => github.pullRequestForBranch(job.repo as RepoName, attemptBranch(job.key, job.attempt)),
): Promise<BranchPull | undefined> {
  if (job.pr_url) return { url: job.pr_url, state: "open" };
  return (await lookup()) ?? undefined;
}
