import { createHash } from "node:crypto";
import { and, eq, gt, inArray, lt, or, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobs, machines, slackMessages, user, type JobRow } from "../db/schema";
import { loadConfig, requireLinearKey } from "../lib/config";
import { attemptBranch } from "../lib/factory";
import { reportedSlack } from "../lib/machine";
// The notifier is the one place outside the adapter that comments on an issue (R34), so it takes the client's two calls.
// eslint-disable-next-line no-restricted-imports
import { commentId, linearClient, type LinearClient } from "../lib/linear";
import {
  inQuietHours,
  parseNotificationConfig,
  readNotifications,
  slackTestDetailSchema,
  type NotificationConfig,
  type SlackTarget,
} from "../lib/notifications";
import {
  NOTIFY_WINDOW_MS,
  notifyEvents,
  panelUrl,
  renderMessage,
  renderTest,
  resolution,
  secretValues,
  TOGGLE_OF,
  URGENT,
  type MessageFacts,
  type SlackMessage,
} from "../lib/slack";
import { SlackApiError, slackClient, SlackRateLimited, type SlackClient } from "../lib/slack-api";
import { SOURCE_SHAPES } from "../lib/sources/shapes";
import { branchCosts } from "../lib/spend";

// The Slack notifier: each pass diffs the notification events (lib/slack.ts) against the
// slack_messages rows, resolves the messages whose event went away, edits the ones whose event
// changed and posts the new ones. Every step is keyed by the event id, so a re-tick, a restart or a
// second runner never posts an event twice. Each event goes to its job's owner: a Slack DM when Slack finds them by
// email, else a Linear comment @-mentioning them (R34).

/** Most Slack calls one pass makes; the rest wait for the next tick, so Slack never holds up the runner's queue. */
export const MAX_CALLS_PER_PASS = 25;
/** A row still posting after this belongs to a runner that died mid-post; the event is posted again. */
export const POSTING_STALE_MS = 5 * 60_000;
/** Tries at recording a posted message's channel and ts before the row is left posting. */
const SAVE_ATTEMPTS = 3;

export type SlackSetup = { client: SlackClient; owner: string | null; secrets: readonly string[] };

let cached: { key: string; client: SlackClient } | undefined;

/** The Slack client for this runner's env; one per token, so a pause for Retry-After holds across passes. */
export function slackFromEnv(env: Record<string, string | undefined> = process.env): SlackSetup | null {
  const token = env.SLACK_BOT_TOKEN?.trim();
  if (!token) return null;
  const baseUrl = env.SLACK_API_URL?.trim() || undefined;
  const key = createHash("sha256")
    .update(`${token}\n${baseUrl ?? ""}`)
    .digest("hex");
  if (cached?.key !== key) cached = { key, client: slackClient({ token, baseUrl }) };
  return { client: cached.client, owner: env.SLACK_OWNER_USER_ID?.trim() || null, secrets: secretValues(env) };
}

const dmChannels = new Map<string, string>();
/** Lowercased email → Slack user id, kept for the life of the process; a miss is kept too. */
const slackIds = new Map<string, string | null>();

async function slackIdByEmail(slack: SlackSetup, email: string) {
  const key = email.toLowerCase();
  let id = slackIds.get(key);
  if (id === undefined) {
    id = await slack.client.userIdByEmail(email);
    slackIds.set(key, id);
  }
  return id;
}

type Destination = { channel: string; to: Exclude<SlackTarget, "off"> };

async function dm(slack: SlackSetup, userId: string): Promise<Destination> {
  let channel = dmChannels.get(userId);
  if (!channel) {
    channel = await slack.client.openDm(userId);
    dmChannels.set(userId, channel);
  }
  return { channel, to: "owner" };
}

async function destination(target: SlackTarget, config: NotificationConfig, slack: SlackSetup): Promise<Destination | string> {
  switch (target) {
    case "owner":
      return slack.owner ? dm(slack, slack.owner) : "SLACK_OWNER_USER_ID is not set on this runner";
    case "channel":
      return config.channelId ? { channel: config.channelId, to: "channel" } : "no channel is set";
    case "off":
      return "notifications are off";
    default: {
      const never: never = target;
      throw new Error(`unknown Slack target ${String(never)}`);
    }
  }
}

const fingerprint = (message: SlackMessage) => createHash("sha256").update(JSON.stringify(message)).digest("hex").slice(0, 32);
const errorText = (error: unknown) => (error instanceof Error ? error.message : String(error));

export type NotifyResult = { posted: number; updated: number; resolved: number; held: number; errors?: string[]; rateLimitedUntil?: string; deferred?: true };
export type NotifyLinear = Pick<LinearClient, "userByEmail" | "comment">;

/** Without a Slack connection, or with the target on owner, each event goes to its job's owner (R34). */
export async function notifySlack(slack: SlackSetup | null = slackFromEnv(), now = new Date(), linear?: NotifyLinear): Promise<NotifyResult> {
  // Slack-less here but configured on another online runner: that runner owns the notifications, so this one never claims an event.
  // A machine that has not reported its Slack inventory (no `slack` key, or unknown) or is offline does not count as having Slack:
  // reportedSlack returns null for it and this runner posts the Linear fallback.
  if (
    !slack &&
    reportedSlack(await db.select({ last_seen_at: machines.last_seen_at, inventory: machines.inventory }).from(machines), now.getTime())?.configured
  ) {
    return { posted: 0, updated: 0, resolved: 0, held: 0 };
  }
  const config = parseNotificationConfig((await readNotifications(db))?.config);
  await db.delete(slackMessages).where(and(eq(slackMessages.state, "posting"), lt(slackMessages.created_at, new Date(now.getTime() - POSTING_STALE_MS))));

  // Recent jobs for new events, and every job with an open message, however old, to see if it resolved.
  const cutoff = new Date(now.getTime() - 2 * NOTIFY_WINDOW_MS);
  const openJobs = db.select({ id: slackMessages.job_id }).from(slackMessages).where(eq(slackMessages.state, "open"));
  const loaded = await db
    .select()
    .from(jobs)
    .where(or(gt(jobs.updated_at, cutoff), gt(jobs.stage_at, cutoff), inArray(jobs.id, openJobs)));
  const events = notifyEvents(loaded);
  const eventOf = new Map(events.map((e) => [e.id, e]));
  const rows = await db
    .select()
    .from(slackMessages)
    .where(events.length > 0 ? or(eq(slackMessages.state, "open"), inArray(slackMessages.id, [...eventOf.keys()])) : eq(slackMessages.state, "open"));
  const rowOf = new Map(rows.map((r) => [r.id, r]));
  const jobOf = new Map(loaded.map((j) => [j.id, j]));

  const branchOf = (job: Pick<JobRow, "key" | "attempt">) => attemptBranch(job.key, job.attempt);
  const costs = await branchCosts(
    db,
    [...new Set([...events.map((e) => branchOf(e.job)), ...rows.flatMap((r) => (jobOf.has(r.job_id) ? [branchOf(jobOf.get(r.job_id)!)] : []))])],
    loadConfig().factory.pricing,
  );
  const facts = (job: JobRow): MessageFacts => ({
    panelUrl: panelUrl(),
    spend: costs[branchOf(job)] ?? null,
    secrets: slack?.secrets ?? secretValues(process.env),
  });

  const routed = config.target === "owner" || (config.target === "channel" && !slack);
  const ownerIds = routed ? [...new Set(loaded.flatMap((j) => (j.owner_id ? [j.owner_id] : [])))] : [];
  const emailOf = new Map(
    (ownerIds.length > 0 ? await db.select({ id: user.id, email: user.email }).from(user).where(inArray(user.id, ownerIds)) : []).map((u) => [u.id, u.email]),
  );
  // The owner's Slack DM, or null for a Linear comment: no Slack, no match, or (ownerless) no SLACK_OWNER_USER_ID.
  const route = async (job: JobRow) => {
    if (!slack) return null;
    const email = job.owner_id ? emailOf.get(job.owner_id) : undefined;
    if (!email) return slack.owner ? dm(slack, slack.owner) : null;
    const id = await slackIdByEmail(slack, email);
    return id ? dm(slack, id) : null;
  };
  const commentIds = sql`coalesce(${jobs.source_state}->'factoryCommentIds', '[]'::jsonb)`;

  const result = { posted: 0, updated: 0, resolved: 0, held: 0 };
  const errors: string[] = [];
  let calls = 0;
  const budget = () => calls < MAX_CALLS_PER_PASS;

  try {
    // Resolutions first: a stale "needs you" is worse than a late new one.
    for (const row of rows) {
      if (!budget()) break;
      if (row.state !== "open" || eventOf.get(row.id)?.open) continue;
      const job = jobOf.get(row.job_id);
      const text = resolution(row.kind, job);
      const message = job ? renderMessage({ id: row.id, kind: row.kind, job, reason: "" }, facts(job), text) : null;
      if (row.channel && !slack) continue;
      try {
        if (message && row.channel && row.ts && slack) {
          calls++;
          await slack.client.update(row.channel, row.ts, message);
        }
        await db
          .update(slackMessages)
          .set({ state: "resolved", resolution: text, resolved_at: now, updated_at: now, ...(message && { fingerprint: fingerprint(message) }) })
          .where(and(eq(slackMessages.id, row.id), eq(slackMessages.state, "open")));
        result.resolved++;
      } catch (error) {
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`resolve ${row.id}: ${errorText(error)}`);
      }
    }

    // Open events whose message changed, or came back after it was resolved (a merge GitHub refused).
    for (const event of events) {
      if (!budget()) break;
      const row = rowOf.get(event.id);
      if (!event.open || !row || row.state === "posting" || !row.channel || !row.ts || !slack) continue;
      const message = renderMessage(event, facts(event.job));
      const print = fingerprint(message);
      if (row.state === "open" && row.fingerprint === print) continue;
      try {
        calls++;
        await slack.client.update(row.channel, row.ts, message);
        await db
          .update(slackMessages)
          .set({ state: "open", fingerprint: print, resolution: null, resolved_at: null, updated_at: now })
          .where(eq(slackMessages.id, event.id));
        result.updated++;
      } catch (error) {
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`update ${event.id}: ${errorText(error)}`);
      }
    }

    const quiet = inQuietHours(config.quietHours, now);
    let shared: Destination | string | undefined;
    for (const event of events) {
      if (rowOf.has(event.id) || !config.events[TOGGLE_OF[event.kind]]) continue;
      if (now.getTime() - event.at.getTime() > NOTIFY_WINDOW_MS) continue;
      if (quiet && !URGENT[event.kind]) {
        result.held++;
        continue;
      }
      if (!budget()) break;
      let target: Destination | string | null;
      let mention: string | undefined;
      let issueId: string | undefined;
      if (routed) {
        try {
          target = await route(event.job);
          if (!target) {
            const issue = SOURCE_SHAPES.linear.writeback.safeParse(event.job.writeback);
            if (!issue.success) continue;
            issueId = issue.data.issueId;
            const email = event.job.owner_id ? emailOf.get(event.job.owner_id) : undefined;
            linear ??= linearClient(requireLinearKey(loadConfig()));
            mention = email ? (await linear.userByEmail(email))?.url : undefined;
          }
        } catch (error) {
          if (error instanceof SlackRateLimited) throw error;
          errors.push(`route ${event.id}: ${errorText(error)}`);
          continue;
        }
      } else {
        if (config.target === "off" || !slack) break;
        target = shared ??= await destination(config.target, config, slack);
      }
      if (typeof target === "string") {
        errors.push(`post: ${target}`);
        break;
      }
      const [claimed] = await db
        .insert(slackMessages)
        .values({ id: event.id, job_id: event.job.id, kind: event.kind, state: "posting", created_at: now, updated_at: now })
        .onConflictDoNothing()
        .returning({ id: slackMessages.id });
      if (!claimed) continue;
      const message = renderMessage(event, facts(event.job));
      let posted: { channel: string | null; ts: string | null } = { channel: null, ts: null };
      try {
        calls++;
        if (target) posted = await slack!.client.postMessage(target.channel, message);
        else {
          // The id is recorded before the post, so a crash in between never makes our own comment look like a reply.
          const id = commentId(issueId!, "notify", event.id);
          await db
            .update(jobs)
            .set({
              source_state: sql`jsonb_set(${jobs.source_state}, '{factoryCommentIds}', case when ${commentIds} ? ${id} then ${commentIds} else ${commentIds} || jsonb_build_array(${id}::text) end)`,
            })
            .where(eq(jobs.id, event.job.id));
          await linear!.comment(issueId!, id, [mention, message.text, event.job.pr_url].filter(Boolean).join("\n\n"));
        }
      } catch (error) {
        await db.delete(slackMessages).where(and(eq(slackMessages.id, event.id), eq(slackMessages.state, "posting")));
        if (error instanceof SlackRateLimited) throw error;
        errors.push(`post ${event.id}: ${errorText(error)}`);
        // One shared destination (a bad channel, a revoked token) fails every post the same way, so stop and try again next pass.
        // Routed, each owner has their own DM, so one owner's refusal (cannot_dm_bot) leaves the others' alone.
        if (!routed && error instanceof SlackApiError) break;
        continue;
      }
      result.posted++;
      const saved = {
        state: event.open ? ("open" as const) : ("resolved" as const),
        channel: posted.channel,
        ts: posted.ts,
        fingerprint: fingerprint(message),
        resolution: event.open ? null : resolution(event.kind, event.job),
        resolved_at: event.open ? null : now,
        updated_at: now,
      };
      // The message is in Slack, so the row stays. If every try fails it is left posting, and the
      // stale-posting cleanup posts it again after POSTING_STALE_MS: a rare duplicate, never a loss.
      for (let attempt = 1; ; attempt++) {
        try {
          await db.update(slackMessages).set(saved).where(eq(slackMessages.id, event.id));
          break;
        } catch (error) {
          if (attempt < SAVE_ATTEMPTS) continue;
          errors.push(`save ${event.id}: ${errorText(error)}`);
          break;
        }
      }
    }
  } catch (error) {
    if (!(error instanceof SlackRateLimited)) throw error;
    return { ...result, ...(errors.length > 0 && { errors }), rateLimitedUntil: new Date(error.until).toISOString() };
  }
  return { ...result, ...(errors.length > 0 && { errors }), ...(!budget() && { deferred: true as const }) };
}

/** The slack_test intent: posts a test message where notifications go, or to the owner's DMs while they are off. */
export async function sendSlackTest(detail: unknown, slack: SlackSetup | null = slackFromEnv()) {
  if (!slack) return { error: "this runner has no SLACK_BOT_TOKEN" };
  const { actor } = slackTestDetailSchema.parse(detail);
  const config = parseNotificationConfig((await readNotifications(db))?.config);
  const target = await destination(config.target === "off" ? "owner" : config.target, config, slack);
  if (typeof target === "string") return { error: target };
  const posted = await slack.client.postMessage(target.channel, renderTest(actor));
  return { sent: { to: target.to, channel: posted.channel } };
}
