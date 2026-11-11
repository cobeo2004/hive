import { and, asc, desc, eq, getTableColumns, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { agents, auditLog, deviceFrames, events, jobEvidence, jobs, machines, runs } from "@/db/schema";
import { isJobKey } from "@/lib/factory";
import type { JobId } from "@/lib/sources/shapes";
import { assertMember } from "@/lib/auth/server";

export const RUN_LIMIT = 200;
export const AGENT_OVERVIEW_LIMIT = 1000;
export const SESSION_AGENT_LIMIT = 200;
export const FEED_LIMIT = 50;

export const runsQuery = () => db.select(getTableColumns(runs)).from(runs).orderBy(desc(runs.last_event_at)).limit(RUN_LIMIT);

/** Feeds per-card agent counts and cost on the board. */
export const agentsOverviewQuery = () => db.select(getTableColumns(agents)).from(agents).orderBy(desc(agents.started_at)).limit(AGENT_OVERVIEW_LIMIT);

export const sessionAgentsQuery = (sessionId: string) =>
  db.select(getTableColumns(agents)).from(agents).where(eq(agents.session_id, sessionId)).orderBy(agents.started_at).limit(SESSION_AGENT_LIMIT);

export const sessionEventsQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    // Usage snapshots arrive every half minute and would push everything else out of the feed.
    .where(and(eq(events.session_id, sessionId), ne(events.kind, "usage")))
    .orderBy(desc(events.at), desc(events.event_id))
    .limit(FEED_LIMIT);

export const JOB_LIMIT = 200;

export const jobsQuery = () => db.select(getTableColumns(jobs)).from(jobs).orderBy(desc(jobs.claimed_at)).limit(JOB_LIMIT);

export const machinesQuery = () => db.select(getTableColumns(machines)).from(machines).orderBy(asc(machines.name), asc(machines.id));

export const STAGE_HISTORY_LIMIT = 100;

export const sessionStagesQuery = (sessionId: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.session_id, sessionId), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

/** Every stage report for a job, across all the sessions that worked on it. */
export const jobStagesQuery = (jobKey: string) =>
  db
    .select(getTableColumns(events))
    .from(events)
    .where(and(eq(events.job_key, jobKey), eq(events.kind, "stage")))
    .orderBy(asc(events.at), asc(events.event_id))
    .limit(STAGE_HISTORY_LIMIT);

export const AUDIT_LIMIT = 50;

export const jobAuditQuery = (jobId: JobId) =>
  db.select(getTableColumns(auditLog)).from(auditLog).where(eq(auditLog.job_id, jobId)).orderBy(desc(auditLog.at), desc(auditLog.id)).limit(AUDIT_LIMIT);

export const EVIDENCE_LIMIT = 20;

/** The checks run at each of the job's commits, newest first. */
export const jobEvidenceQuery = (jobKey: string) =>
  db
    .select(getTableColumns(jobEvidence))
    .from(jobEvidence)
    .where(eq(jobEvidence.job_key, jobKey))
    .orderBy(desc(jobEvidence.recorded_at), desc(jobEvidence.sha))
    .limit(EVIDENCE_LIMIT);

/** When the job's latest device frame was taken (R26a); the bytes come from the device-frame route. */
export const deviceFrameQuery = (jobKey: string) => db.select({ taken_at: deviceFrames.taken_at }).from(deviceFrames).where(eq(deviceFrames.job_key, jobKey));

export async function jobIdForKey(jobKey: string) {
  await assertMember();
  const [row] = await db.select({ id: jobs.id }).from(jobs).where(eq(jobs.key, jobKey));
  return row?.id;
}

export async function runJob(sessionId: string) {
  await assertMember();
  const [row] = await db
    .select({ jobKey: runs.job_key, jobId: jobs.id })
    .from(runs)
    .leftJoin(jobs, eq(jobs.key, runs.job_key))
    .where(eq(runs.session_id, sessionId));
  return { jobKey: row?.jobKey ?? undefined, jobId: row?.jobId ?? undefined };
}

/** Runs a feed's query for the owner; a live update re-renders the page, which runs it again. */
export async function load<Row>(query: PromiseLike<Row[]>) {
  await assertMember();
  return { initialData: await query };
}

export const parseJobKey = (value: string) => (isJobKey(value) ? value : undefined);
