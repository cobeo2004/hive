import { assertMember } from "@/lib/auth/server";
import { listen } from "@/lib/listen";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEARTBEAT_MS = 25_000;

/**
 * Live updates: an SSE stream of the names of tables that changed. The panel re-renders on each, so
 * no rows travel here and the page's own owner-checked reads stay the only source of data.
 */
// ponytail: one Postgres connection per open tab, fine for ~10 tabs; a single shared LISTEN client fanned out in-process is the upgrade if tabs grow.
export async function GET(request: Request) {
  await assertMember();
  const encoder = new TextEncoder();
  let stop = () => {};
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      let done = false;
      const held: { client?: Awaited<ReturnType<typeof listen>>; heartbeat?: ReturnType<typeof setInterval> } = {};
      const send = (text: string) => {
        if (!done) controller.enqueue(encoder.encode(text));
      };
      // Set before the LISTEN awaits, so a cancel or error during setup still ends the client that arrives after.
      stop = () => {
        if (done) return;
        done = true;
        clearInterval(held.heartbeat);
        // Ending the connection drops its LISTEN, so no UNLISTEN is needed.
        void held.client?.end().catch(() => {});
        try {
          controller.close();
        } catch {
          // The browser already went away.
        }
      };
      request.signal.addEventListener("abort", stop);
      const client = (held.client = await listen((table) => send(`data: ${table}\n\n`), () => stop()));
      if (done || request.signal.aborted) {
        done = true;
        await client.end().catch(() => {});
        return;
      }
      held.heartbeat = setInterval(() => send(": heartbeat\n\n"), HEARTBEAT_MS);
      // A real event, not a comment: the panel refreshes on it, catching up on writes made before LISTEN or while disconnected.
      send("data: connected\n\n");
    },
    cancel: () => stop(),
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" },
  });
}
