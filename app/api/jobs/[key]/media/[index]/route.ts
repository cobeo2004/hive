import { and, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, jobMedia } from "@/db/schema";
import { parseAssessment } from "@/lib/assessment";
import { parseJobKey } from "@/lib/live-queries";

/** One image or video of the job's current assessment, by its place in the list; the proxy lets only the owner through. */
export async function GET(request: Request, { params }: RouteContext<"/api/jobs/[key]/media/[index]">) {
  const { key: rawKey, index } = await params;
  const key = parseJobKey(rawKey);
  if (!key || !/^\d+$/.test(index)) return Response.json({ error: "invalid media" }, { status: 400 });
  const [job] = await db.select({ reportId: jobs.assessment_event_id, assessment: jobs.merge_assessment }).from(jobs).where(eq(jobs.key, key));
  const ref = parseAssessment(job?.assessment)?.media?.[Number(index)];
  // `v` names the report the URL was made for; a newer report's images get new URLs.
  if (!job?.reportId || !ref || new URL(request.url).searchParams.get("v") !== job.reportId) return Response.json({ error: "no such media" }, { status: 404 });
  const [row] = await db
    .select({ bytes: jobMedia.bytes, contentType: jobMedia.content_type })
    .from(jobMedia)
    .where(and(eq(jobMedia.stage_event_id, job.reportId), eq(jobMedia.file, ref.file)));
  if (!row) return Response.json({ error: "the media hasn't arrived" }, { status: 404 });
  // The URL names the report it belongs to, so the same URL always means the same file.
  const headers = { "Content-Type": row.contentType, "Cache-Control": "private, max-age=31536000, immutable", "Accept-Ranges": "bytes" };
  const bytes = new Uint8Array(row.bytes);
  // Safari won't play a <video> without byte ranges; `bytes=a-b` and `bytes=a-` only (no suffix ranges).
  const range = /^bytes=(\d+)-(\d*)$/.exec(request.headers.get("range") ?? "");
  if (!range) return new Response(bytes, { headers });
  const start = Number(range[1]);
  const end = Math.min(range[2] ? Number(range[2]) : bytes.length - 1, bytes.length - 1);
  if (start > end) return new Response(null, { status: 416, headers: { "Content-Range": `bytes */${bytes.length}` } });
  return new Response(bytes.subarray(start, end + 1), { status: 206, headers: { ...headers, "Content-Range": `bytes ${start}-${end}/${bytes.length}` } });
}
