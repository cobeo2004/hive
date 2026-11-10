import { sql } from "drizzle-orm";
import {
  boolean,
  check,
  customType,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  real,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { STAGES } from "../lib/events";
import type { AssessmentInput } from "../lib/assessment";
import type { CheckSource, EvidenceCheck, EvidenceSummary, Producer } from "../lib/evidence";
import { DEFAULT_EXECUTION, type Execution } from "../lib/execution";
import type { Autonomy, MergeDecision } from "../lib/merge-decision";
import type { NotificationConfig } from "../lib/notifications";
import type { ScreenshotType } from "../lib/screenshots";
import { ONBOARDING_STATES, type OnboardingDetail } from "../lib/onboarding";
import type { NotifyKind, SlackMessageState } from "../lib/slack";
import type { JobId, JobSource } from "../lib/sources/shapes";
import type { StopRecord } from "../lib/stop";
import type { TicketRecord } from "../lib/ticket-overrides";

// Keys equal column names: the Neon Realtime Drizzle adapter requires it.
// Token counters are float8 because int8 and numeric reach live subscribers as strings.

export const runStatus = pgEnum("run_status", ["active", "idle", "ended"]);
export const runStage = pgEnum("run_stage", STAGES);
export const agentStatus = pgEnum("agent_status", ["running", "completed", "failed"]);

const ts = (name: string) => timestamp(name, { withTimezone: true });

const tokens = () => ({
  input_tokens: doublePrecision("input_tokens").notNull().default(0),
  output_tokens: doublePrecision("output_tokens").notNull().default(0),
  cache_read_tokens: doublePrecision("cache_read_tokens").notNull().default(0),
  cache_write_tokens: doublePrecision("cache_write_tokens").notNull().default(0),
});

export const events = pgTable(
  "events",
  {
    event_id: text("event_id").primaryKey(),
    session_id: text("session_id").notNull(),
    kind: text("kind").notNull(),
    at: ts("at").notNull(),
    // Set on stage events, so a job's stage history spans every session that worked on it.
    job_key: text("job_key"),
    payload: jsonb("payload").notNull(),
    /** Why ingest refused this stage event; null when the job and the run took it. */
    refusal: text("refusal"),
  },
  (t) => [index("events_session_at_idx").on(t.session_id, t.at), index("events_job_key_idx").on(t.job_key)],
);

export const runs = pgTable(
  "runs",
  {
    session_id: text("session_id").primaryKey(),
    cwd: text("cwd"),
    repo: text("repo"),
    branch: text("branch"),
    job_key: text("job_key"),
    t3_thread_id: text("t3_thread_id"),
    title: text("title"),
    status: runStatus("status").notNull().default("active"),
    stage: runStage("stage"),
    // Stage moves on its own clock: a stage report can land after a later turn_stop.
    stage_at: ts("stage_at"),
    stage_summary: text("stage_summary"),
    question: text("question"),
    pr_url: text("pr_url"),
    transcript_path: text("transcript_path"),
    started_at: ts("started_at").notNull(),
    last_event_at: ts("last_event_at").notNull(),
    model: text("model"),
    /** The agent account this attempt ran on (R36); null before M3 or once the account is deleted. */
    account_id: text("account_id").references(() => agentAccounts.id, { onDelete: "set null" }),
    ...tokens(),
  },
  (t) => [index("runs_last_event_at_idx").on(t.last_event_at), index("runs_account_idx").on(t.account_id)],
);

export const agents = pgTable(
  "agents",
  {
    tool_use_id: text("tool_use_id").primaryKey(),
    session_id: text("session_id").notNull(),
    agent_id: text("agent_id").unique(),
    parent_agent_id: text("parent_agent_id"),
    subagent_type: text("subagent_type"),
    description: text("description"),
    model: text("model"),
    status: agentStatus("status").notNull().default("running"),
    started_at: ts("started_at").notNull(),
    ended_at: ts("ended_at"),
    ...tokens(),
  },
  (t) => [index("agents_session_idx").on(t.session_id)],
);

export const jobs = pgTable(
  "jobs",
  {
    id: text("id").primaryKey().$type<JobId>(),
    /** A key of SOURCES (lib/sources); text, so a new source needs no enum migration. */
    source: text("source").$type<JobSource>().notNull().default("linear"),
    external_id: text("external_id").notNull(),
    key: text("key").notNull().unique(),
    title: text("title").notNull(),
    url: text("url").notNull(),
    description: text("description"),
    repo: text("repo").notNull(),
    writeback: jsonb("writeback").notNull(),
    source_state: jsonb("source_state").notNull(),
    stage: runStage("stage").notNull().default("queued"),
    stage_at: ts("stage_at"),
    stage_summary: text("stage_summary"),
    question: text("question"),
    pr_url: text("pr_url"),
    /** The stage event the job's stage came from; write-back keys its source comment on it. */
    stage_event_id: text("stage_event_id"),
    synced_event_id: text("synced_event_id"),
    /** Reply ids already handed to a thread; the replay guard for resumes. */
    delivered_reply_ids: jsonb("delivered_reply_ids").$type<string[]>().notNull().default([]),
    answered_at: ts("answered_at"),
    answer: text("answer"),
    /** The question and answer a relaunched thread gets when the original thread is gone. */
    resume_context: text("resume_context"),
    /** Each retry after a failure is a new attempt on its own branch. */
    attempt: integer("attempt").notNull().default(1),
    /** Why the previous attempt failed; the next attempt's first message quotes it. */
    previous_failure: text("previous_failure"),
    /** The owner's note for one attempt, from Retry in the inbox. Keyed by attempt, so a later attempt ignores a stale note and the claim need not clear it. */
    attempt_note: jsonb("attempt_note").$type<{ attempt: number; text: string }>(),
    /** Unused: the per-attempt cap it held was removed. Kept, with a default, for runners and ingest deployed before that. */
    budget_usd: doublePrecision("budget_usd").notNull().default(5),
    /** When the watchdog nudged a stuck run, and in which stage; cleared once the stage moves on. */
    nudged_at: ts("nudged_at"),
    nudged_stage: runStage("nudged_stage"),
    /** The thread a stop message reached; a stop recorded before the thread was known waits for it. */
    stop_sent_to: text("stop_sent_to"),
    /** The stop recorded for this attempt. A later stage, such as a merge, leaves it, so an owed stop is still sent. */
    stop_event_id: text("stop_event_id"),
    /** Where the attempt's stop is on its way to a verified end; see lib/stop.ts. Null for a job never stopped. */
    stop: jsonb("stop").$type<StopRecord>(),
    /** The PR head the factory last sent back to its thread because it conflicted with main. */
    conflict_head: text("conflict_head"),
    t3_thread_id: text("t3_thread_id"),
    machine_id: text("machine_id"),
    /** The T3 provider instance and model this attempt's thread was launched with; null before a launch. */
    provider: text("provider"),
    model: text("model"),
    /** Where this attempt's thread was launched; null before a launch and for launches recorded before it was kept. */
    execution: text("execution").$type<Execution>(),
    /** What the ticket's override labels asked for at launch and each fallback the runner took instead; see lib/ticket-overrides.ts. */
    ticket_overrides: jsonb("ticket_overrides").$type<TicketRecord>(),
    session_id: text("session_id"),
    /** The Modal sandbox this attempt runs in; null when it runs in the machine's own T3. */
    sandbox_id: text("sandbox_id"),
    /** The Modal image a hibernated sandbox was snapshotted to; set while the job waits with no sandbox running. */
    sandbox_snapshot: text("sandbox_snapshot"),
    /** The runner-side CODEX_HOME whose ChatGPT login the sandbox holds; one job per slot. */
    codex_slot: text("codex_slot"),
    /** The agent's assessment from its latest pr report on this attempt; rows from before the six checks were dropped keep that shape, so read it with parseAssessment. */
    merge_assessment: jsonb("merge_assessment").$type<AssessmentInput>(),
    /** The pr stage event merge_assessment came from; its screenshots are stored under it (job_screenshots). */
    assessment_event_id: text("assessment_event_id"),
    /** The runner's latest merge decision while the job sits in pr; see lib/merge-decision.ts. */
    merge_decision: jsonb("merge_decision").$type<MergeDecision>(),
    /** The latest evidence for the current attempt, without output; job_evidence keeps every commit's. See lib/evidence.ts. */
    evidence: jsonb("evidence").$type<EvidenceSummary>(),
    /** When the owner dismissed the job from the inbox; a failure newer than this shows again. */
    dismissed_at: ts("dismissed_at"),
    /** Review feedback already handed to the thread, from the panel or GitHub; the replay guard for request_changes. */
    delivered_feedback_ids: jsonb("delivered_feedback_ids").$type<string[]>().notNull().default([]),
    /** When the owner archived the finished job off the panel; a stage newer than this shows it again. See lib/archive.ts. */
    archived_at: ts("archived_at"),
    archived_by: text("archived_by"),
    /** The job's owner (R35): the assignee if they are a Hive user, else the creator if they are, else null. Null for jobs from before M2. */
    owner_id: text("owner_id").references(() => user.id, { onDelete: "set null" }),
    claimed_at: ts("claimed_at").notNull(),
    updated_at: ts("updated_at").notNull(),
  },
  (t) => [
    index("jobs_claimed_at_idx").on(t.claimed_at),
    index("jobs_owner_idx").on(t.owner_id),
    uniqueIndex("jobs_codex_slot_idx").on(t.codex_slot).where(sql`${t.codex_slot} is not null`),
    check("jobs_id_check", sql`${t.id} = ${t.source}::text || ':' || ${t.external_id}`),
  ],
);

/**
 * Who holds each Codex login slot: a job or an onboarding agent run. The slot is the primary key,
 * so one holder at a time across both. Triggers from migration 0032 keep it in step with
 * jobs.codex_slot and a repo's onboarding_detail run slot: setting either to a slot someone else
 * holds fails with a unique violation, and clearing it releases the slot. Onboarding records its
 * agent run with the slot before it creates the sandbox; see runner/onboarding.ts.
 */
export const codexSlotLeases = pgTable(
  "codex_slot_leases",
  {
    slot: text("slot").primaryKey(),
    holder_kind: text("holder_kind").$type<"job" | "onboarding">().notNull(),
    /** The job's id, or the repo an onboarding run is for. */
    holder_id: text("holder_id").notNull(),
    leased_at: ts("leased_at").notNull().defaultNow(),
  },
  (t) => [check("codex_slot_leases_holder_kind_check", sql`${t.holder_kind} in ('job', 'onboarding')`)],
);

/**
 * The checks run at one commit of a job, from an evidence event (lib/evidence.ts). One row per job
 * and commit: a later run at the same commit replaces it, except that a run with uncommitted
 * changes never replaces a clean one, since it says nothing about the commit.
 */
export const jobEvidence = pgTable(
  "job_evidence",
  {
    job_key: text("job_key").notNull(),
    sha: text("sha").notNull(),
    attempt: integer("attempt").notNull(),
    repo: text("repo").notNull(),
    clean: boolean("clean").notNull(),
    producer: text("producer").$type<Producer>().notNull(),
    source: text("source").$type<CheckSource>().notNull(),
    checks: jsonb("checks").$type<EvidenceCheck[]>().notNull(),
    event_id: text("event_id").notNull(),
    recorded_at: ts("recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.job_key, t.sha] }), index("job_evidence_job_recorded_idx").on(t.job_key, t.recorded_at)],
);

const bytea = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => "bytea" });

/**
 * One screenshot a pr report's assessment attached (lib/screenshots.ts), keyed by that stage event
 * and the file it names, so the panel finds the current assessment's images from jobs.stage_event_id.
 */
export const jobScreenshots = pgTable(
  "job_screenshots",
  {
    stage_event_id: text("stage_event_id").notNull(),
    file: text("file").notNull(),
    job_key: text("job_key").notNull(),
    content_type: text("content_type").$type<ScreenshotType>().notNull(),
    bytes: bytea("bytes").notNull(),
    event_id: text("event_id").notNull(),
    recorded_at: ts("recorded_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.stage_event_id, t.file] }), index("job_screenshots_job_idx").on(t.job_key)],
);

/** Every webhook delivery, keyed by its id, so a redelivery is recognised and changes nothing. */
export const webhookDeliveries = pgTable("webhook_deliveries", {
  delivery_id: text("delivery_id").primaryKey(),
  source: text("source").notNull(),
  event: text("event").notNull(),
  received_at: ts("received_at").notNull(),
  payload: jsonb("payload").notNull(),
});

export const intentKind = pgEnum("intent_kind", [
  "claim",
  "stop",
  "answer",
  "merged",
  "recheck_conflicts",
  "open_t3",
  "approve_merge",
  "request_changes",
  "close_job",
  "onboard_repo",
  "rebuild_repo_image",
  "repo_push",
  "retry_stop",
  "retry_job",
  "slack_test",
]);

/**
 * What a webhook asks the runner to do. Webhooks only record these; the runner acts on each one
 * through the same idempotent code its timer and startup reconcile use, then sets handled_at.
 * The panel records open_t3 itself; its result holds a one-time T3 pairing link until the panel
 * shows it or it expires. The inbox records approve_merge, request_changes and close_job; a
 * human's GitHub review records request_changes too. Their detail is JSON; see lib/inbox.ts.
 * The Repositories page records onboard_repo and rebuild_repo_image with the repo as detail; a push
 * to a default branch records repo_push with the repo and the changed files (lib/webhooks.ts).
 * Settings records slack_test with the owner as detail; a runner with a Slack token posts the test message.
 */
export const intents = pgTable(
  "intents",
  {
    id: text("id").primaryKey(),
    kind: intentKind("kind").notNull(),
    job_id: text("job_id").$type<JobId>(),
    pr_url: text("pr_url"),
    detail: text("detail"),
    created_at: ts("created_at").notNull(),
    handled_at: ts("handled_at"),
    attempts: integer("attempts").notNull().default(0),
    retry_at: ts("retry_at"),
    result: text("result"),
    /** The machine working on the intent; another machine may take it once lease_until has passed. */
    leased_by: text("leased_by"),
    lease_until: ts("lease_until"),
  },
  (t) => [index("intents_open_idx").on(t.handled_at, t.created_at)],
);

/** One row per machine that handled a broadcast intent, so each machine acts on it exactly once. */
export const intentReceipts = pgTable(
  "intent_receipts",
  {
    intent_id: text("intent_id")
      .notNull()
      .references(() => intents.id, { onDelete: "cascade" }),
    machine_id: text("machine_id").notNull(),
    handled_at: ts("handled_at").notNull(),
    result: text("result"),
  },
  (t) => [primaryKey({ columns: [t.intent_id, t.machine_id] })],
);

export const machines = pgTable("machines", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  last_seen_at: ts("last_seen_at").notNull(),
  heartbeat: jsonb("heartbeat").notNull(),
  inventory: jsonb("inventory"),
  inventory_at: ts("inventory_at"),
});

/** Factory-wide settings the panel edits; the one row has id "factory". */
export const settings = pgTable("settings", {
  id: text("id").primaryKey(),
  /** The T3 provider instance new threads start on. */
  provider: text("provider").notNull(),
  model: text("model").notNull(),
  /** Where runners start new threads; see lib/execution.ts. */
  execution: text("execution").$type<Execution>().notNull().default(DEFAULT_EXECUTION),
  updated_at: ts("updated_at").notNull(),
  /** The owner's email. */
  updated_by: text("updated_by").notNull(),
});

/** Where Slack notifications go and which events send one; the one row has id "factory". See lib/notifications.ts. */
export const notificationSettings = pgTable("notification_settings", {
  id: text("id").primaryKey(),
  /** Read with parseNotificationConfig, so a row saved by an older panel still parses. */
  config: jsonb("config").$type<NotificationConfig>().notNull(),
  updated_at: ts("updated_at").notNull(),
  /** The owner's email. */
  updated_by: text("updated_by").notNull(),
});

/**
 * One Slack message per notification event (lib/slack.ts), keyed by the event's identity, so a
 * re-tick, a restart or a second runner never posts it twice. The runner inserts the row in
 * `posting` before it posts, then records where the message went; an `open` message is updated
 * while its event changes and once more, to `resolved`, when its event goes away.
 */
export const slackMessages = pgTable(
  "slack_messages",
  {
    id: text("id").primaryKey(),
    job_id: text("job_id").$type<JobId>().notNull(),
    kind: text("kind").$type<NotifyKind>().notNull(),
    state: text("state").$type<SlackMessageState>().notNull(),
    channel: text("channel"),
    ts: text("ts"),
    /** A hash of the message last sent, so an unchanged event is not updated again. */
    fingerprint: text("fingerprint"),
    /** What the resolved message says happened; null while open. */
    resolution: text("resolution"),
    created_at: ts("created_at").notNull(),
    updated_at: ts("updated_at").notNull(),
    resolved_at: ts("resolved_at"),
  },
  (t) => [
    index("slack_messages_state_idx").on(t.state),
    index("slack_messages_job_idx").on(t.job_id),
    check("slack_messages_state_check", sql`${t.state} in ('posting', 'open', 'resolved')`),
  ],
);

export const onboardingState = pgEnum("onboarding_state", ONBOARDING_STATES);

/**
 * The repositories the factory works in, and per repo its merge policy and launch defaults; see
 * lib/repositories.ts. A repo with no row merges nothing and runs on Settings.
 */
export const repoSettings = pgTable(
  "repo_settings",
  {
    /** The GitHub full name, owner/name. */
    repo: text("repo").primaryKey(),
    /** The name the panel and the Repository label show; null means the name part of repo. */
    display_name: text("display_name"),
    /** Where an issue without a Repository label goes; at most one row, and it must be enabled. */
    is_default: boolean("is_default").notNull().default(false),
    /** A disabled repo takes no new jobs; a Repository label naming it goes to the default. */
    enabled: boolean("enabled").notNull().default(true),
    /** The T3 provider instance this repo's jobs start on without a Harness label; null means Settings. */
    provider: text("provider"),
    /** Where this repo's jobs run without a Runs on label; null means Settings. */
    execution: text("execution").$type<Execution>(),
    autonomy: text("autonomy").$type<Autonomy>().notNull().default("off"),
    /** Globs a PR may not touch to merge on its own; null means the defaults. */
    protected_paths: jsonb("protected_paths").$type<string[]>(),
    /** Most additions plus deletions a PR may have to merge on its own; null means the default. */
    max_changed_lines: integer("max_changed_lines"),
    /** Whether a PR waits for and is held to Bugbot's review; false for a repo without Bugbot. */
    require_bugbot: boolean("require_bugbot").notNull().default(true),
    /** Where onboarding stands (lib/onboarding.ts); null for a repo registered before onboarding existed. */
    onboarding_state: onboardingState("onboarding_state"),
    /** The recipe, its PR, check results, secret names (never values), the warm image and any run in flight. */
    onboarding_detail: jsonb("onboarding_detail").$type<OnboardingDetail>(),
    onboarding_started_at: ts("onboarding_started_at"),
    /** When onboarding_state last changed. */
    onboarding_at: ts("onboarding_at"),
    updated_at: ts("updated_at").notNull(),
    updated_by: text("updated_by").notNull(),
  },
  (t) => [
    uniqueIndex("repo_settings_one_default_idx").on(t.is_default).where(sql`${t.is_default}`),
    check("repo_settings_default_enabled_check", sql`not ${t.is_default} or ${t.enabled}`),
  ],
);

export const auditAction = pgEnum("audit_action", [
  "merge_requested",
  "merge_succeeded",
  "merge_failed",
  "sandbox_login_failed",
  "merge_decided",
  "override_fallback",
  "follow_up_filed",
  "review_dropped",
  "job_archived",
  "job_unarchived",
]);
export const auditResult = pgEnum("audit_result", ["ok", "head_moved", "not_mergeable", "refused", "error"]);

/** Who asked the factory to change something outside it, and what happened. */
export const auditLog = pgTable(
  "audit_log",
  {
    id: text("id").primaryKey(),
    at: ts("at").notNull(),
    /** The owner's email from the session. */
    actor: text("actor").notNull(),
    action: auditAction("action").notNull(),
    job_id: text("job_id").notNull().$type<JobId>(),
    /** The PR URL. */
    target: text("target").notNull(),
    head_sha: text("head_sha").notNull(),
    /** Null on a request; set on its outcome. */
    result: auditResult("result"),
    /** GitHub's message, or why the panel refused. */
    detail: text("detail"),
  },
  (t) => [index("audit_log_job_at_idx").on(t.job_id, t.at)],
);

export type EventRow = typeof events.$inferSelect;
export type RunRow = typeof runs.$inferSelect;
export type AgentRow = typeof agents.$inferSelect;
export type JobRow = typeof jobs.$inferSelect;
export type IntentRow = typeof intents.$inferSelect;
export type IntentKind = IntentRow["kind"];
export type MachineRow = typeof machines.$inferSelect;
export type SettingsRow = typeof settings.$inferSelect;
export type RepoSettingsRow = typeof repoSettings.$inferSelect;
export type AuditRow = typeof auditLog.$inferSelect;
export type JobEvidenceRow = typeof jobEvidence.$inferSelect;
export type NotificationSettingsRow = typeof notificationSettings.$inferSelect;
export type SlackMessageRow = typeof slackMessages.$inferSelect;

// Better Auth (R3, R4, R33). Property names are the adapter's field names; columns are snake_case.
// Foreign keys to "user" cascade, as Better Auth's own schema does.
export const user = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: ts("created_at").notNull().defaultNow(),
  updatedAt: ts("updated_at").notNull().defaultNow(),
  /** "admin" or "engineer" (R4). */
  role: text("role"),
  banned: boolean("banned").default(false),
  banReason: text("ban_reason"),
  banExpires: ts("ban_expires"),
  twoFactorEnabled: boolean("two_factor_enabled").default(false),
  /** Set when the user finishes /setup (R5, R33). */
  setupDoneAt: ts("setup_done_at"),
});

export const session = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: ts("expires_at").notNull(),
    token: text("token").notNull().unique(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    impersonatedBy: text("impersonated_by"),
  },
  (t) => [index("session_user_id_idx").on(t.userId)],
);

export const account = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: ts("access_token_expires_at"),
    refreshTokenExpiresAt: ts("refresh_token_expires_at"),
    scope: text("scope"),
    password: text("password"),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("account_user_id_idx").on(t.userId)],
);

export const verification = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: ts("expires_at").notNull(),
    createdAt: ts("created_at").notNull().defaultNow(),
    updatedAt: ts("updated_at").notNull().defaultNow(),
  },
  (t) => [index("verification_identifier_idx").on(t.identifier)],
);

export const twoFactor = pgTable(
  "two_factor",
  {
    id: text("id").primaryKey(),
    secret: text("secret").notNull(),
    backupCodes: text("backup_codes").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => user.id, { onDelete: "cascade" }),
    verified: boolean("verified").default(true),
    failedVerificationCount: integer("failed_verification_count").default(0),
    lockedUntil: ts("locked_until"),
  },
  (t) => [index("two_factor_user_id_idx").on(t.userId), index("two_factor_secret_idx").on(t.secret)],
);

export const accessLinkKind = pgEnum("access_link_kind", ["setup", "invite", "reset"]);

/** One-time setup, invite and reset links (R32). Only the token's sha256 is stored. */
export const accessLinks = pgTable("access_links", {
  id: text("id").primaryKey(),
  kind: accessLinkKind("kind").notNull(),
  token_hash: text("token_hash").notNull().unique(),
  /** Null for a setup link: the first admin chooses their email. */
  email: text("email"),
  expires_at: ts("expires_at").notNull(),
  used_at: ts("used_at"),
  created_by: text("created_by").references(() => user.id, { onDelete: "cascade" }),
});

/** Which Linear triggers a user opted in to (R35); one row per user who opted in. The label trigger stays global. */
export const linearOptIns = pgTable("linear_opt_ins", {
  /** The user who opted in (R35). */
  user_id: text("user_id")
    .primaryKey()
    .references(() => user.id, { onDelete: "cascade" }),
  /** Pick up issues assigned to this user (R35). */
  assigned: boolean("assigned").notNull().default(false),
  /** Stop this user's jobs at the plan gate for approval (R35). */
  plan_approval: boolean("plan_approval").notNull().default(false),
  /** When the user last changed their opt-ins (R35). */
  updated_at: ts("updated_at").notNull(),
});

/** Linear teams, pickup label and Hive's Linear user, edited in Settings (R35); the one row has id "factory". */
export const linearSettings = pgTable("linear_settings", {
  /** Always "factory" (R35). */
  id: text("id").primaryKey(),
  /** The team keys Hive watches, the pickup label and Hive's Linear user id (R35). */
  config: jsonb("config").$type<{ teamKeys: string[]; label: string; hiveUserId: string | null }>().notNull(),
  /** When an admin last saved the settings (R35). */
  updated_at: ts("updated_at").notNull(),
  /** The admin's email (R35). */
  updated_by: text("updated_by").notNull(),
});

export const agentProvider = pgEnum("agent_provider", ["claude", "codex"]);
export const agentAccountKind = pgEnum("agent_account_kind", ["subscription", "api_key"]);

/**
 * A Claude or Codex account agents run on (R36): an engineer's own, or a pool account when owner_id
 * is null. The token is stored only sealed; disconnecting sets disconnected_at and clears sealed to
 * empty bytes.
 */
export const agentAccounts = pgTable(
  "agent_accounts",
  {
    id: text("id").primaryKey(),
    /** The engineer who owns it; null for a pool account (R36). */
    owner_id: text("owner_id").references(() => user.id, { onDelete: "cascade" }),
    provider: agentProvider("provider").notNull(),
    kind: agentAccountKind("kind").notNull(),
    label: text("label").notNull(),
    /** The sealed token; the panel cannot open it (R36). */
    sealed: bytea("sealed").notNull(),
    created_by: text("created_by").references(() => user.id, { onDelete: "set null" }),
    created_at: ts("created_at").notNull().defaultNow(),
    disconnected_at: ts("disconnected_at"),
  },
  (t) => [index("agent_accounts_owner_idx").on(t.owner_id)],
);

export const usageWindow = pgEnum("usage_window", ["5h", "7d"]);

/** The last usage reading of an account for one rate-limit window (R36). */
export const accountUsage = pgTable(
  "account_usage",
  {
    account_id: text("account_id")
      .notNull()
      .references(() => agentAccounts.id, { onDelete: "cascade" }),
    window: usageWindow("window").notNull(),
    used_pct: real("used_pct").notNull(),
    resets_at: ts("resets_at"),
    read_at: ts("read_at").notNull(),
  },
  (t) => [primaryKey({ columns: [t.account_id, t.window] }), check("account_usage_used_pct_range", sql`${t.used_pct} >= 0 and ${t.used_pct} <= 100`)],
);

export const accountLoginStatus = pgEnum("account_login_status", ["pending", "waiting_code", "done", "failed"]);

/**
 * A login in progress, relaying the login URL and device code to the user (R36). It never holds a
 * token, and the login flow deletes the row when the login ends.
 */
export const accountLogins = pgTable("account_logins", {
  id: text("id").primaryKey(),
  user_id: text("user_id")
    .notNull()
    .references(() => user.id, { onDelete: "cascade" }),
  provider: agentProvider("provider").notNull(),
  status: accountLoginStatus("status").notNull().default("pending"),
  url: text("url"),
  code: text("code"),
  expires_at: ts("expires_at").notNull(),
  created_at: ts("created_at").notNull().defaultNow(),
});
