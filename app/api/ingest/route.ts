import { timingSafeEqual } from "node:crypto";
import { db } from "@/db/client";
import { ingestBodySchema } from "@/lib/events";
import { ingest } from "@/lib/ingest";

export const runtime = "nodejs";

function authorized(request: Request) {
  const secret = process.env.FACTORY_INGEST_SECRET;
  if (!secret) return false;
  const expected = Buffer.from(`Bearer ${secret}`);
  const given = Buffer.from(request.headers.get("authorization") ?? "");
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Where the reporter's hooks, its MCP server and the runner post events. The proxy lets it through; the Bearer secret is the check. */
export async function POST(request: Request) {
  if (!authorized(request)) return Response.json({ error: "unauthorized" }, { status: 401 });
  const json = await request.json().catch(() => undefined);
  const parsed = ingestBodySchema.safeParse(json);
  if (!parsed.success) {
    return Response.json({ error: "invalid body", issues: parsed.error.issues }, { status: 400 });
  }
  return Response.json(await ingest(db, parsed.data));
}
