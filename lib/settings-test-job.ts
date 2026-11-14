import { createHash } from "node:crypto";
import { and, desc, eq, like } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { jobsHref } from "@/components/panel/job-view";
import type * as schema from "@/db/schema";
import { jobEvidence, jobMedia, jobs, machines } from "@/db/schema";
import { isAdmin, type SessionUser } from "@/lib/auth/owner";
import { testJobBlocker } from "@/lib/machine";
import { REVIEW_LABEL } from "@/lib/merge-decision";
import { createJob, type NewJobDeps } from "@/lib/new-job";
import { requestId as uuid } from "@/lib/request-id";
import { checks, TEST_JOB_REPO, testJobDescription } from "@/lib/test-job";

// Settings → Machines' "Run test job": files lib/test-job.ts's devices job through the panel's New job path and,
// once it settles, shows the canary's checks. The title marks the job, so it needs no column.

export const TEST_JOB_TITLE = "Settings test job";

type Db = NodePgDatabase<typeof schema>;
type Row = typeof jobs.$inferSelect;
type Deps = { db: Db; user: () => Promise<SessionUser | null | undefined>; newJob: NewJobDeps };
export type TestJobLink = { key: string; href: string };
export type TestJobStatus = { repo: string; last: (TestJobLink & { stage: string; checks: ReturnType<typeof checks> | null }) | null };
export type RunTestJobOutcome = ({ ok: true; existing: boolean } & TestJobLink) | { ok: false; message: string };

const latest = async (db: Db) =>
  (
    await db
      .select()
      .from(jobs)
      .where(like(jobs.title, `${TEST_JOB_TITLE}%`))
      .orderBy(desc(jobs.claimed_at))
      .limit(1)
  )[0];

/** Finished, or at its PR with the decision the checks read. A job waiting on a question is not settled: answer it. */
const settled = (job: Row) => job.stage === "merged" || job.stage === "failed" || (job.stage === "pr" && job.merge_decision !== null);

const link = (job: Row): TestJobLink => ({ key: job.key, href: job.session_id ? jobsHref("list", job.session_id) : job.url });

export async function runTestJob(deps: Deps): Promise<RunTestJobOutcome> {
  if (!isAdmin(await deps.user())) return { ok: false, message: "Only an admin can run the test job." };
  const last = await latest(deps.db);
  // An unsettled job is shown whatever the machines say now; readiness only gates filing a new one.
  if (last && !settled(last)) return { ok: true, existing: true, ...link(last) };
  const blocker = testJobBlocker(await deps.db.select().from(machines), Date.now());
  if (blocker) return { ok: false, message: blocker };
  // Keyed on the job before it: a second click before the runner claims this one gets Linear's issue back, not a new one.
  const requestId = uuid(
    createHash("sha256")
      .update(`settings-test-job\n${last?.key ?? "first"}`)
      .digest()
      .subarray(0, 16),
  );
  const title = `${TEST_JOB_TITLE} ${new Date().toISOString().slice(0, 16).replace("T", " ")}: unit converter demo page on devices`;
  const description = testJobDescription("devices", "Settings → Machines");
  const filed = await createJob(deps.newJob, { requestId, title, description, execution: "local", repo: TEST_JOB_REPO }, [REVIEW_LABEL]);
  return filed.ok ? { ok: true, existing: false, key: filed.identifier, href: filed.url } : { ok: false, message: filed.message };
}

/** The latest test job, with lib/test-job.ts's checks once it settled, read as scripts/canary.ts reads them. */
export async function testJobStatus(db: Db): Promise<TestJobStatus> {
  const job = await latest(db);
  if (!job) return { repo: TEST_JOB_REPO, last: null };
  if (!settled(job)) return { repo: TEST_JOB_REPO, last: { ...link(job), stage: job.stage, checks: null } };
  const media = job.assessment_event_id
    ? await db.select({ file: jobMedia.file, bytes: jobMedia.bytes }).from(jobMedia).where(eq(jobMedia.stage_event_id, job.assessment_event_id))
    : [];
  // The PR head the merge decision read, so evidence that passed at an older commit does not count for a newer head.
  // A decision that did not ask GitHub (headSha null) leaves the head unknown: unverified, not the evidence's sha.
  const sha = job.merge_decision ? job.merge_decision.headSha : job.evidence?.sha;
  const [evidence] = sha
    ? await db
        .select()
        .from(jobEvidence)
        .where(and(eq(jobEvidence.job_key, job.key), eq(jobEvidence.sha, sha)))
    : [];
  // ponytail: the panel has no gh, so the head is the decision's (else the latest evidence's) and its state the stage's; the canary asks GitHub.
  const head = job.pr_url ? { sha: sha ?? "", state: job.stage === "pr" ? "OPEN" : job.stage.toUpperCase() } : null;
  return { repo: TEST_JOB_REPO, last: { ...link(job), stage: job.stage, checks: checks("devices", job, head, media, evidence) } };
}
