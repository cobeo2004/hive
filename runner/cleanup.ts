import { and, inArray, lt, sql } from "drizzle-orm";
import { db } from "../db/client";
import { jobMedia, jobs } from "../db/schema";

const MEDIA_RETENTION_DAYS = 30;

/**
 * Deletes the images and videos of jobs that ended (merged, or failed, which is where a closed PR lands)
 * more than 30 days ago, and returns how many files went. `dryRun` only counts them.
 */
export async function sweepMedia({ now = Date.now(), dryRun = false }: { now?: number; dryRun?: boolean } = {}): Promise<number> {
  const ended = db
    .select({ key: jobs.key })
    .from(jobs)
    .where(and(inArray(jobs.stage, ["merged", "failed"]), lt(jobs.stage_at, new Date(now - MEDIA_RETENTION_DAYS * 86_400_000))));
  const where = inArray(jobMedia.job_key, ended);
  if (dryRun) return (await db.select({ n: sql<number>`count(*)::int` }).from(jobMedia).where(where))[0]!.n;
  return (await db.delete(jobMedia).where(where).returning({ file: jobMedia.file })).length;
}
