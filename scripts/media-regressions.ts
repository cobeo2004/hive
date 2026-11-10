import "./test-guard";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";
import { NextRequest } from "next/server";
import type { MergeAssessment } from "../lib/assessment";
import type { FactoryEvent } from "../lib/events";
import type { DecisionInput } from "../lib/merge-decision";

process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";

const { db } = await import("../db/client");
const { events, jobs, jobMedia, runs } = await import("../db/schema");
const { session } = await import("../lib/auth/server");
const { proxy } = await import("../proxy");
const { sweepMedia } = await import("../runner/cleanup");
const { linearJob } = await import("./fixtures");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { attemptBranch } = await import("../lib/factory");
const { eventSchema, stageReportSchema } = await import("../lib/events");
const { ingest } = await import("../lib/ingest");
const { parseAssessment } = await import("../lib/assessment");
const { appendEvent, flushOutbox, localFs } = await import("../lib/outbox");
const { decideMerge, DEFAULT_POLICY } = await import("../lib/merge-decision");
const { MAX_IMAGE_BYTES, MAX_MEDIA, mediaUrl, sniffType, uiFiles } = await import("../lib/media");
const { readMedia, mediaEvents, unreadable } = await import("../lib/media-files");
const { GET } = await import("../app/api/jobs/[key]/media/[index]/route");

const stamp = Date.now() % 1_000_000;
const dir = mkdtempSync(join(tmpdir(), "media-regress-"));
const runsDir = join(dir, "runs");
const mediaDir = join(runsDir, "run-a", "media");
mkdirSync(mediaDir, { recursive: true });
const KEY = `MEDIA-${stamp}`;
const KEYS = [KEY, `${KEY}-OLD`, `${KEY}-NEW`];

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("png body")]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from("ftypisom"), Buffer.alloc(2_000_000)]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("jpeg body")]);
writeFileSync(join(mediaDir, "list.png"), PNG);
writeFileSync(join(mediaDir, "empty.jpeg"), JPEG);
writeFileSync(join(mediaDir, "flow.mp4"), MP4);
writeFileSync(join(mediaDir, "big.mp4"), MP4.subarray(0, 12));
truncateSync(join(mediaDir, "big.mp4"), 30_000_000);
writeFileSync(join(mediaDir, "notes.txt"), "not an image");
writeFileSync(join(mediaDir, "huge.png"), Buffer.concat([PNG, Buffer.alloc(MAX_IMAGE_BYTES)]));
writeFileSync(join(dir, "outside.png"), PNG);
symlinkSync(join(dir, "outside.png"), join(mediaDir, "escape.png"));

const assessment = (over: Partial<MergeAssessment> = {}): MergeAssessment => ({
  recommendation: "merge",
  interpretation: "Sort the list by name.",
  assumptions: [],
  confidence: { confident: true },
  ...over,
});
const shots = [
  { file: "list.png", caption: "The list sorted by name." },
  { file: "empty.jpeg", caption: "The empty state." },
  { file: "flow.mp4", caption: "Sorting, recorded." },
];

try {
  // --- the files the agent may attach
  assert.equal(sniffType(PNG), "image/png");
  assert.equal(sniffType(JPEG), "image/jpeg");
  assert.equal(sniffType(MP4), "video/mp4");
  assert.equal(sniffType(Buffer.from("RIFF\0\0\0\0WEBPVP8 ")), "image/webp");
  assert.equal(sniffType(Buffer.from("<svg/>")), null, "an SVG could carry script, so it is no media");
  const read = readMedia("list.png", runsDir);
  assert.ok(read.ok && read.contentType === "image/png" && read.bytes.equals(PNG), "a file in the run's media folder reads back as itself");
  assert.ok(readMedia("flow.mp4", runsDir).ok, "a 2 MB video is within the video limit");
  const refusal = (file: string) => {
    const r = readMedia(file, runsDir);
    return r.ok ? null : r.reason;
  };
  assert.match(refusal("gone.png")!, /is not in any/);
  assert.match(refusal("notes.txt")!, /not a png, jpg, webp, mp4 or mov file/);
  assert.match(refusal("huge.png")!, /over the 1000000 limit/);
  assert.match(refusal("big.mp4")!, /big\.mp4 is 30000000 bytes, over the 25000000 limit/, "a video over 25 MB is refused with its name and size");
  assert.match(refusal(join(dir, "outside.png"))!, /is not in any/, "a path is no file name");
  assert.match(refusal("../outside.png")!, /is not in any/, "a relative path out of the dir");
  assert.match(refusal("escape.png")!, /is not in any/, "a symlink out of the dir");
  assert.deepEqual(
    unreadable([...shots, { file: "notes.txt", caption: "x" }], runsDir),
    ["notes.txt is not a png, jpg, webp, mp4 or mov file"],
    "only the bad file is named",
  );

  // --- the report_stage shape
  const pr = { stage: "pr", summary: "Opened", prUrl: "https://github.com/o/r/pull/1" };
  assert.ok(stageReportSchema.safeParse({ ...pr, assessment: assessment({ media: shots }) }).success, "an assessment takes media");
  const items = (n: number) => Array.from({ length: n }, () => shots[0]!);
  assert.ok(stageReportSchema.safeParse({ ...pr, assessment: assessment({ media: items(MAX_MEDIA) }) }).success, "six are fine");
  assert.ok(!stageReportSchema.safeParse({ ...pr, assessment: assessment({ media: items(MAX_MEDIA + 1) }) }).success, "a seventh is refused");
  assert.ok(!stageReportSchema.safeParse({ ...pr, assessment: assessment({ media: [{ file: "list.png", caption: "" }] }) }).success, "each needs a caption");
  assert.deepEqual(parseAssessment(assessment({ media: shots }))?.media, shots, "a stored assessment keeps its media");
  assert.equal(parseAssessment({ ...assessment(), media: [] })?.media, undefined, "an empty list reads as none");

  // --- the events the reporter sends
  const stageEventId = `stage-${stamp}`;
  const sessionId = `mcp:${attemptBranch(KEY, 1)}`;
  const sent = mediaEvents([...shots, shots[0]!, { file: "notes.txt", caption: "x" }], { jobKey: KEY, stageEventId, sessionId, at: Date.now() }, runsDir);
  assert.deepEqual(
    sent.map((e) => e.file),
    ["list.png", "empty.jpeg", "flow.mp4"],
    "one event per readable file, in the assessment's order",
  );
  for (const item of sent) assert.ok(eventSchema.safeParse(item).success, `${item.file} is a valid event`);
  assert.equal(
    sent[0]!.eventId,
    mediaEvents(shots, { jobKey: KEY, stageEventId, sessionId, at: 0 }, runsDir)[0]!.eventId,
    "a retried report sends the same ids",
  );
  assert.ok(
    !eventSchema.safeParse({ ...sent[0], data: Buffer.alloc(25_000_000 + 3).toString("base64") }).success,
    "ingest refuses a file over the video limit",
  );

  // --- the outbox keeps a batch of media under one request's size
  {
    const state = join(dir, "outbox");
    for (const item of sent) appendEvent(state, item as FactoryEvent);
    appendEvent(state, { eventId: `small-${stamp}`, sessionId, at: Date.now(), kind: "session_end" });
    const batches: string[][] = [];
    const flushed = await flushOutbox(localFs, state, async (batch) => (batches.push(batch.map((e) => e.eventId)), { kind: "delivered" }), {
      budgetMs: 5_000,
      maxChars: 300,
    });
    assert.equal(flushed.delivered, 4);
    assert.deepEqual(batches.flat(), [...sent.map((e) => e.eventId), `small-${stamp}`], "still oldest first");
    assert.ok(batches.length === 4 && batches.every((b) => b.length === 1), `each event over the cap goes alone: ${JSON.stringify(batches)}`);
  }

  // --- ingest stores the bytes once, and the panel serves the current report's media
  await db.insert(jobs).values(linearJob(`media-regress-${KEY}`, KEY, { machine_id: TEST_MACHINE_ID, stage: "verifying", attempt: 1 }));
  const stage: FactoryEvent = {
    eventId: stageEventId,
    sessionId,
    at: Date.now(),
    kind: "stage",
    ...pr,
    stage: "pr",
    assessment: assessment({ media: shots }),
    jobKey: KEY,
    branch: attemptBranch(KEY, 1),
  };
  const first = await ingest(db, [...sent, stage]);
  assert.equal(first.inserted, 4);
  assert.deepEqual(first.refused, [], "the pr report applies");
  const again = await ingest(db, sent);
  assert.equal(again.inserted, 0, "a redelivered file changes nothing");
  const stored = await db.select().from(jobMedia).where(eq(jobMedia.job_key, KEY));
  assert.deepEqual(stored.map((s) => [s.file, s.content_type, s.stage_event_id]).sort(), [
    ["empty.jpeg", "image/jpeg", stageEventId],
    ["flow.mp4", "video/mp4", stageEventId],
    ["list.png", "image/png", stageEventId],
  ]);
  assert.ok(Buffer.from(stored.find((s) => s.file === "list.png")!.bytes).equals(PNG), "the bytes round-trip");
  assert.deepEqual(
    stored.map((s) => [s.file, s.kind]).sort(),
    [
      ["empty.jpeg", "image"],
      ["flow.mp4", "video"],
      ["list.png", "image"],
    ],
    "an mp4 is stored as a video, the rest as images",
  );
  assert.ok(Buffer.from(stored.find((s) => s.file === "flow.mp4")!.bytes).equals(MP4), "a 2 MB video round-trips");
  const logged = await db
    .select({ payload: events.payload })
    .from(events)
    .where(
      inArray(
        events.event_id,
        sent.map((e) => e.eventId),
      ),
    );
  assert.ok(
    logged.every((l) => (l.payload as { data: string }).data === ""),
    "the event log keeps no media bytes",
  );
  const [job] = await db.select().from(jobs).where(eq(jobs.key, KEY));
  assert.equal(job!.stage, "pr");
  assert.equal(job!.stage_event_id, stageEventId);
  assert.equal(job!.assessment_event_id, stageEventId, "the job remembers which report its assessment came from");

  const get = (index: number, v: string | null = stageEventId) =>
    GET(new Request(`http://panel${mediaUrl(KEY, index, v)}`), { params: Promise.resolve({ key: KEY, index: String(index) }) } as never);
  const one = await get(0);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get("content-type"), "image/png");
  assert.ok(Buffer.from(await one.arrayBuffer()).equals(PNG), "the panel serves the stored media");
  assert.equal((await get(1)).headers.get("content-type"), "image/jpeg");
  assert.equal((await get(2)).headers.get("content-type"), "video/mp4");
  assert.equal((await get(3)).status, 404, "past the assessment's list");
  assert.equal((await get(0, "older-report")).status, 404, "a URL from an earlier report never shows this report's media");

  // Only a signed-in user gets bytes: the proxy guards the route, which then serves whole files and byte ranges.
  const DONE = new Date("2026-11-10T00:00:00Z");
  const signIn = (user: object | null) => Object.assign(session, { read: async () => (user ? { user, session: {} } : null) });
  const mediaRequest = (range?: string) => new NextRequest(`http://localhost:3000${mediaUrl(KEY, 2, stageEventId)}`, { headers: range ? { range } : {} });
  const params = { params: Promise.resolve({ key: KEY, index: "2" }) } as never;
  signIn(null);
  assert.equal((await proxy(mediaRequest())).status, 401, "no session, no media");
  signIn({ id: "u", email: "e@unibuz.com.au", name: "E", role: "engineer", twoFactorEnabled: true, setupDoneAt: DONE });
  assert.ok((await proxy(mediaRequest())).headers.has("x-middleware-next"), "a finished user passes the proxy");
  const whole = await GET(mediaRequest(), params);
  assert.equal(whole.status, 200);
  assert.ok(Buffer.from(await whole.arrayBuffer()).equals(MP4), "a signed-in user gets the stored video");
  const part = await GET(mediaRequest("bytes=0-3"), params);
  assert.equal(part.status, 206, "a byte range is partial content");
  assert.equal(part.headers.get("content-range"), `bytes 0-3/${MP4.length}`);
  assert.ok(Buffer.from(await part.arrayBuffer()).equals(MP4.subarray(0, 4)), "four bytes of the video");

  // A later stage moves stage_event_id; the assessment and its media belong to the pr report still.
  const after: FactoryEvent = {
    eventId: `${stageEventId}-failed`,
    sessionId,
    at: Date.now() + 1,
    kind: "stage",
    stage: "failed",
    summary: "CI kept failing.",
    jobKey: KEY,
    branch: attemptBranch(KEY, 1),
  };
  assert.deepEqual((await ingest(db, [after])).refused, [], "the later stage applies");
  const [moved] = await db.select().from(jobs).where(eq(jobs.key, KEY));
  assert.equal(moved!.stage_event_id, after.eventId);
  assert.equal(mediaUrl(KEY, 0, moved!.assessment_event_id), mediaUrl(KEY, 0, stageEventId), "the panel's URL stays the pr report's");
  assert.equal((await get(0)).status, 200, "the media still serves after a later stage");
  await db.update(jobs).set({ stage: "pr" }).where(eq(jobs.key, KEY));

  // A report naming a file whose bytes never arrived: the panel says so instead of showing another.
  const later: FactoryEvent = {
    ...stage,
    eventId: `${stageEventId}-2`,
    at: Date.now() + 2,
    assessment: assessment({ media: [{ file: "late.png", caption: "Late." }] }),
  };
  await ingest(db, [later]);
  assert.equal((await get(0, later.eventId)).status, 404, "media that hasn't arrived");

  // --- the merge decision: a UI change needs media when the agent had a browser
  const input = (over: Partial<DecisionInput> = {}): DecisionInput => ({
    policy: { ...DEFAULT_POLICY, autonomy: "auto" },
    assessment: assessment(),
    labels: [],
    pr: {
      headSha: "h1",
      mergeable: "mergeable",
      checks: "success",
      bugbot: { review: { state: "reviewed" }, findings: [] },
      files: [{ path: "src/list.tsx", additions: 3, deletions: 1 }],
    },
    headSeenAt: 0,
    now: 1,
    evidence: { state: "verified", sha: "h1", passed: 1, total: 1, producer: "agent" },
    runner: { kind: "unavailable", reason: "n/a" },
    browser: true,
    trustEdits: [],
    ...over,
  });
  assert.deepEqual(
    decideMerge(input()),
    { outcome: "handover", reasons: ["The pull request changes UI files (src/list.tsx), but the agent attached no media."] },
    "a UI change without media hands over",
  );
  assert.deepEqual(decideMerge(input({ assessment: assessment({ media: shots }) })), { outcome: "merge", reasons: [] }, "with media it merges");
  assert.deepEqual(decideMerge(input({ assessment: assessment({ media: [shots[2]!] }) })), { outcome: "merge", reasons: [] }, "a video alone is media enough");
  assert.deepEqual(decideMerge(input({ browser: false })), { outcome: "merge", reasons: [] }, "a run with no browser can't take media, so it isn't held to it");
  const many = ["a.tsx", "b.css", "c.vue", "d.html", "e.ts"].map((path) => ({ path, additions: 1, deletions: 0 }));
  assert.match(
    decideMerge(input({ pr: { ...input().pr!, files: many } })).reasons[0]!,
    /\(a\.tsx, b\.css, c\.vue and 1 more\)/,
    "names three and counts the rest",
  );
  assert.deepEqual(
    decideMerge(input({ pr: { ...input().pr!, files: [{ path: "lib/sort.ts", additions: 3, deletions: 1 }] } })),
    { outcome: "merge", reasons: [] },
    "a change no page shows needs none",
  );
  assert.deepEqual(uiFiles(["app/page.tsx", "styles/site.scss", "README.md", "lib/a.ts"]), ["app/page.tsx", "styles/site.scss"]);

  // --- the sweep drops the media of a job that ended over 30 days ago, and keeps a newer one's
  const [oldKey, newKey] = [KEYS[1]!, KEYS[2]!];
  for (const [key, days] of [
    [oldKey, 31],
    [newKey, 29],
  ] as const) {
    await db.insert(jobs).values(linearJob(`media-sweep-${key}`, key, { stage: "merged", stage_at: new Date(Date.now() - days * 86_400_000) }));
    await db.insert(jobMedia).values({
      stage_event_id: `sweep-${key}`,
      file: "a.png",
      job_key: key,
      content_type: "image/png",
      bytes: PNG,
      event_id: `sweep-ev-${key}`,
      recorded_at: new Date(),
    });
  }
  await sweepMedia();
  assert.equal((await db.select().from(jobMedia).where(eq(jobMedia.job_key, oldKey))).length, 0, "a job merged 31 days ago loses its media");
  assert.equal((await db.select().from(jobMedia).where(eq(jobMedia.job_key, newKey))).length, 1, "one merged 29 days ago keeps it");

  console.log("media regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobMedia).where(inArray(jobMedia.job_key, KEYS));
  await db.delete(events).where(eq(events.job_key, KEY));
  await db.delete(runs).where(eq(runs.job_key, KEY));
  await db.delete(jobs).where(inArray(jobs.key, KEYS));
  rmSync(dir, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
