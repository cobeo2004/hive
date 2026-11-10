import "./test-guard";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { deviceFrames, deviceViewers, jobs, user } = await import("../db/schema");
const { TEST_MACHINE_ID } = await import("../lib/config");
const { readDeviceFrame } = await import("../lib/t3-client");
const { captureFrames } = await import("../runner/device-frames");
const { linearJob } = await import("./fixtures");

const stamp = Date.now() % 1_000_000;
const prefix = `device-frames-${stamp}`;
const keys = { A: `DFA-${stamp}`, B: `DFB-${stamp}`, C: `DFC-${stamp}`, D: `DFD-${stamp}`, E: `DFE-${stamp}`, F: `DFF-${stamp}` };
const all = Object.values(keys);
const userId = `${prefix}-viewer`;

type FrameJob = { key: string; t3_thread_id: string };
const calls = { device_list: 0, device_screenshot: 0 };
const asked: string[] = [];
const pngs = new Map<string, Buffer | Error>();
const closed = new Set<string>();
const frame = (job: FrameJob) =>
  readDeviceFrame(async (tool) => {
    calls[tool]++;
    asked.push(job.key);
    if (tool === "device_list") return { open: closed.has(job.key) ? [] : [{ hostId: "host", deviceId: "device" }] };
    const value = pngs.get(job.key);
    if (!value) throw new Error(`no stub frame for ${job.key}`);
    if (value instanceof Error) throw value;
    return { screenshot: { data: value.toString("base64") } };
  });

const frameRow = async (key: string) => (await db.select().from(deviceFrames).where(eq(deviceFrames.job_key, key)))[0];
const frameRows = (jobKeys: string[]) => db.select().from(deviceFrames).where(inArray(deviceFrames.job_key, jobKeys));

try {
  await db.insert(user).values({ id: userId, name: "Device viewer", email: `${prefix}@example.com` });
  await db
    .insert(jobs)
    .values([
      linearJob(`${prefix}-a`, keys.A, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thr-a-${stamp}` }),
      linearJob(`${prefix}-b`, keys.B, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thr-b-${stamp}` }),
      linearJob(`${prefix}-c`, keys.C, { machine_id: TEST_MACHINE_ID, stage: "pr", t3_thread_id: `thr-c-${stamp}` }),
      linearJob(`${prefix}-d`, keys.D, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thr-d-${stamp}`, sandbox_id: `sb-${stamp}` }),
      linearJob(`${prefix}-e`, keys.E, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thr-e-${stamp}` }),
      linearJob(`${prefix}-f`, keys.F, { machine_id: TEST_MACHINE_ID, stage: "implementing", t3_thread_id: `thr-f-${stamp}` }),
    ]);
  // F's heartbeat is stale (20 s); the others' are fresh and added after the no-viewer check.
  await db.insert(deviceViewers).values({ job_key: keys.F, user_id: userId, seen_at: new Date(Date.now() - 20_000) });

  // 1. No fresh viewer: no T3 call at all and no frame.
  const noViewer = await captureFrames(TEST_MACHINE_ID, frame);
  assert.deepEqual(noViewer, { captured: [], failed: [] });
  assert.deepEqual(calls, { device_list: 0, device_screenshot: 0 }, "no viewer means no T3 call");
  assert.equal((await frameRows([keys.E, keys.F])).length, 0, "E and F have no frame");

  // 2. A and B have fresh viewers: both frames are stored; C, D, E and F are never asked.
  await db.insert(deviceViewers).values([keys.A, keys.B, keys.C, keys.D].map((job_key) => ({ job_key, user_id: userId, seen_at: new Date() })));
  const pngA = Buffer.from("frame A one");
  const pngB = Buffer.from("frame B one");
  pngs.set(keys.A, pngA);
  pngs.set(keys.B, pngB);
  const watched = await captureFrames(TEST_MACHINE_ID, frame);
  assert.deepEqual(watched.captured.sort(), [keys.A, keys.B].sort(), "both watched jobs captured");
  assert.deepEqual(watched.failed, []);
  assert.deepEqual(calls, { device_list: 2, device_screenshot: 2 }, "one list and one screenshot per watched job");
  assert.deepEqual((await frameRow(keys.A))?.png, pngA, "A stores the stub bytes");
  assert.deepEqual((await frameRow(keys.B))?.png, pngB, "B stores the stub bytes");
  assert.equal((await frameRows([keys.C, keys.D, keys.E, keys.F])).length, 0, "unwatchable or unwatched jobs have no frame");
  assert.ok(!asked.some((key) => [keys.C, keys.D, keys.E, keys.F].includes(key)), "C, D, E and F are never asked");

  // 3. Latest only: one row per job, replaced with the newer bytes and time.
  const pngA2 = Buffer.from("frame A two");
  pngs.set(keys.A, pngA2);
  const earlier = (await frameRow(keys.A))!;
  await new Promise((resolve) => setTimeout(resolve, 5));
  await captureFrames(TEST_MACHINE_ID, frame);
  const latest = (await frameRow(keys.A))!;
  assert.equal((await frameRows([keys.A])).length, 1, "A keeps exactly one frame");
  assert.deepEqual(latest.png, pngA2, "A's frame is the newer bytes");
  assert.ok(latest.taken_at > earlier.taken_at, "A's frame time advanced");

  // 4. A's screenshot throws: A is reported, B still captures, and A's earlier frame survives.
  const beforeFailure = (await frameRow(keys.A))!;
  pngs.set(keys.A, new Error("stub screenshot failed"));
  const isolated = await captureFrames(TEST_MACHINE_ID, frame);
  assert.deepEqual(
    isolated.failed.map((failure) => failure.key),
    [keys.A],
    "A is the failed job",
  );
  assert.deepEqual(isolated.captured, [keys.B], "B is still captured");
  assert.deepEqual(await frameRow(keys.A), beforeFailure, "A's earlier frame is untouched");

  // 5. No open device: device_list is enough; no screenshot, no row.
  await db.delete(deviceFrames).where(inArray(deviceFrames.job_key, [keys.A, keys.B]));
  closed.add(keys.A);
  closed.add(keys.B);
  const shotsBefore = calls.device_screenshot;
  const noDevice = await captureFrames(TEST_MACHINE_ID, frame);
  assert.deepEqual(noDevice, { captured: [], failed: [] });
  assert.equal(calls.device_screenshot, shotsBefore, "no open device means no screenshot");
  assert.equal((await frameRows([keys.A, keys.B])).length, 0, "no open device writes no frame");

  // 6. The view is input-free: no event handlers, buttons or inputs.
  const view = readFileSync("components/panel/device-view.tsx", "utf8");
  assert.doesNotMatch(view, /\son[A-Z]\w*=/, "device-view has no event handler");
  assert.ok(!view.includes("<button"), "device-view has no button");
  assert.ok(!view.includes("<input"), "device-view has no input");

  console.log("device-frames regressions passed");
} finally {
  await db.delete(deviceFrames).where(inArray(deviceFrames.job_key, all));
  await db.delete(deviceViewers).where(inArray(deviceViewers.job_key, all));
  await db.delete(jobs).where(inArray(jobs.key, all));
  await db.delete(user).where(eq(user.id, userId));
}
process.exit(0);
