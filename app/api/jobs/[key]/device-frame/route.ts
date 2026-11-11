import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { deviceFrames, deviceViewers } from "@/db/schema";
import { currentUser } from "@/lib/auth/server";
import { isMember } from "@/lib/auth/owner";
import { parseJobKey } from "@/lib/live-queries";

/** The job's latest device frame. `v` is only a cache-buster; the proxy lets signed-in users through, and any member may watch. */
export async function GET(_request: Request, { params }: RouteContext<"/api/jobs/[key]/device-frame">) {
  const key = parseJobKey((await params).key);
  if (!key) return Response.json({ error: "invalid job key" }, { status: 400 });
  const [frame] = await db.select({ png: deviceFrames.png }).from(deviceFrames).where(eq(deviceFrames.job_key, key));
  if (!frame) return Response.json({ error: "no frame yet" }, { status: 404 });
  return new Response(new Uint8Array(frame.png), { headers: { "Content-Type": "image/png", "Cache-Control": "private, no-store" } });
}

/**
 * The open Run detail's heartbeat; the runner captures frames only while one is under 15 s old.
 * A route, not a server action, which Next runs one at a time: a 5 s heartbeat would queue behind the user's own actions.
 */
export async function POST(_request: Request, { params }: RouteContext<"/api/jobs/[key]/device-frame">) {
  const me = await currentUser();
  if (!isMember(me) || !me.id) return Response.json({ error: "sign in to Hive first" }, { status: 401 });
  const key = parseJobKey((await params).key);
  if (!key) return Response.json({ error: "invalid job key" }, { status: 400 });
  const seen_at = new Date();
  await db
    .insert(deviceViewers)
    .values({ job_key: key, user_id: me.id, seen_at })
    .onConflictDoUpdate({ target: [deviceViewers.job_key, deviceViewers.user_id], set: { seen_at } });
  return new Response(null, { status: 204 });
}
