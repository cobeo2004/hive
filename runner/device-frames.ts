import { and, eq, exists, gt, isNotNull, isNull, inArray, sql } from "drizzle-orm";
import { db } from "../db/client";
import { deviceFrames, deviceViewers, jobs } from "../db/schema";
import { localHost } from "../lib/host";
import { deviceFrame } from "../lib/t3-client";
import { IN_FLIGHT } from "./ops";
import { message } from "./queue";

const VIEWER_FRESH_MS = 15_000;

type FrameJob = { key: string; t3_thread_id: string };

/**
 * Stores the latest device frame of each of this machine's running local jobs that someone is
 * watching (a viewer heartbeat under 15 s old). No such job means no T3 call at all; one job's
 * failure does not stop the next.
 */
export async function captureFrames(machineId: string, frame: (job: FrameJob) => Promise<Buffer | null> = () => deviceFrame(localHost), now = Date.now()) {
  const watched = await db
    .select({ key: jobs.key, t3_thread_id: jobs.t3_thread_id })
    .from(jobs)
    .where(
      and(
        eq(jobs.machine_id, machineId),
        inArray(jobs.stage, IN_FLIGHT),
        isNotNull(jobs.t3_thread_id),
        // Devices live on the host Mac, not in a sandbox.
        isNull(jobs.sandbox_id),
        isNull(jobs.sandbox_snapshot),
        exists(
          db
            .select({ one: sql`1` })
            .from(deviceViewers)
            .where(and(eq(deviceViewers.job_key, jobs.key), gt(deviceViewers.seen_at, new Date(now - VIEWER_FRESH_MS)))),
        ),
      ),
    );
  const captured: string[] = [];
  const failed: { key: string; error: string }[] = [];
  for (const job of watched) {
    try {
      const png = await frame({ key: job.key, t3_thread_id: job.t3_thread_id! });
      if (!png) continue;
      const taken_at = new Date();
      // ponytail: no pruning of device_frames: one PNG per watched job is bounded by jobs; prune in cleanup if the table grows.
      await db.insert(deviceFrames).values({ job_key: job.key, png, taken_at }).onConflictDoUpdate({ target: deviceFrames.job_key, set: { png, taken_at } });
      captured.push(job.key);
    } catch (error) {
      failed.push({ key: job.key, error: message(error) });
    }
  }
  return { captured, failed };
}
