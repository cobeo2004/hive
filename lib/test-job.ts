import { createHash } from "node:crypto";
import type { jobEvidence, jobs } from "../db/schema";

// One definition of a test job: the ticket an agent gets and the checks its PR must pass. scripts/canary.ts
// files it; `browser` proves a Modal sandbox can drive the playwright browser, `devices` proves a pool Mac
// can test on T3's browser, the iOS Simulator and the Android Emulator in one job.

type TestJobVariant = "browser" | "devices";
type Job = Pick<typeof jobs.$inferSelect, "execution" | "sandbox_id" | "sandbox_snapshot" | "machine_id" | "merge_decision" | "pr_url">;
type Evidence = Pick<typeof jobEvidence.$inferSelect, "clean" | "producer" | "checks">;
type PrHead = { sha: string; state: string };
type Check = { name: string; ok: boolean; detail: string };
type Media = { file: string; bytes: Uint8Array };

const PORT = 4173;
/** The repo test jobs run against unless the canary is told otherwise. */
export const TEST_JOB_REPO = "ski043/factory-playground";
const DEVICE_MEDIA = ["after-browser.png", "after-ios.png", "after-android.png"] as const;

/** A PNG's width and height from its IHDR chunk, or null for anything else. */
function pngSize(bytes: Uint8Array) {
  if (bytes.length < 24 || bytes[0] !== 0x89 || bytes[1] !== 0x50) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// ponytail: three different images with portrait phones, not proof of which device took each; the owner reads
// the screenshots on the PR. Upgrade path: record the capturing device on each job_media row.
function distinctCaptures(media: Media[]): Check {
  const shots = DEVICE_MEDIA.map((file) => media.find((m) => m.file === file));
  if (shots.some((m) => !m)) return { name: "three distinct captures, phones portrait", ok: true, detail: "checked once all three are attached" };
  const hashes = new Set(shots.map((m) => createHash("sha256").update(m!.bytes).digest("hex")));
  const landscape = shots.slice(1).filter((m) => {
    const size = pngSize(m!.bytes);
    return !size || size.height <= size.width;
  });
  return {
    name: "three distinct captures, phones portrait",
    ok: hashes.size === 3 && landscape.length === 0,
    detail: [hashes.size < 3 && "an image is reused", ...landscape.map((m) => `${m!.file} is not a portrait PNG`)].filter(Boolean).join("; ") || "ok",
  };
}

const PAGE = `Add \`demo/index.html\`: one static page titled "Unit converter demo" with a heading and a table of five conversions this library does (for example 10 km in miles), the numbers written into the HTML by hand. No build step, no script tag, no new dependency, and nothing else in the repo changes.`;

const STEPS: Record<TestJobVariant, string> = {
  browser: `1. Serve the page on localhost with a static server that is already installed, for example \`python3 -m http.server ${PORT} --directory demo\`.
2. Open http://localhost:${PORT}/ with the \`playwright\` browser and save a viewport screenshot of the page to \`.sstack/runs/canary/media/after-page.png\` in the repo.
3. Run \`factory-verify\` at your final commit.
4. Open the pull request and report \`pr\` with that screenshot attached to your assessment as \`media\`: \`{ file: "after-page.png", caption: "The demo page with its conversions table." }\`.`,
  devices: `1. Serve the page on a free port with a static server that is already installed, for example \`python3 -m http.server <port> --directory demo\`.
2. Open http://localhost:<port>/ in T3's browser (the preview tools) and save a screenshot to \`.sstack/runs/canary/media/after-browser.png\`.
3. Open http://localhost:<port>/ in Safari on an iOS Simulator (the T3 device tools), in portrait orientation (rotate the device if needed), and save a screenshot to \`.sstack/runs/canary/media/after-ios.png\`.
4. Open http://10.0.2.2:<port>/ in Chrome on an Android Emulator (the T3 device tools), in portrait orientation (rotate the device if needed), and save a screenshot to \`.sstack/runs/canary/media/after-android.png\`.
5. Shut down only the simulators and emulators you booted; leave the ones that were already running.
6. Run \`factory-verify\` at your final commit.
7. Open the pull request and report \`pr\` with the three screenshots attached to your assessment as \`media\`, one caption each naming where it was taken.`,
};

export function testJobDescription(variant: TestJobVariant, filedBy = "scripts/canary.ts") {
  return `Factory canary, filed by ${filedBy} to check a rollout. Its pull request is for the owner to read and close, never to merge.

${PAGE}

Then, in this order:
${STEPS[variant]}`;
}

/** What the job has proven so far; every check must hold once it reached its PR. Pure: the caller reads the rows and the PR. */
export function checks(variant: TestJobVariant, job: Job, head: PrHead | null, media: Media[], evidence: Evidence | undefined): Check[] {
  const failedChecks = evidence?.checks.filter((c) => c.exitCode !== 0).map((c) => c.name) ?? [];
  const decision = job.merge_decision;
  const files = media.map((m) => m.file);
  const missing = DEVICE_MEDIA.filter((f) => !files.includes(f));
  return [
    variant === "browser"
      ? {
          name: "launched in a sandbox",
          ok: job.execution === "modal" && Boolean(job.sandbox_id ?? job.sandbox_snapshot),
          detail: `execution ${job.execution ?? "none"}`,
        }
      : {
          name: "ran local on a pool Mac",
          ok: job.execution === "local" && Boolean(job.machine_id) && !job.sandbox_id && !job.sandbox_snapshot,
          detail: `execution ${job.execution ?? "none"} on ${job.machine_id ?? "no machine"}${job.sandbox_id || job.sandbox_snapshot ? ", with a sandbox" : ""}`,
        },
    { name: "opened a PR", ok: head?.state === "OPEN", detail: job.pr_url ? `${job.pr_url} is ${head?.state ?? "unreadable"}` : "no PR yet" },
    variant === "browser"
      ? { name: "media attached", ok: files.length > 0, detail: files.length > 0 ? files.join(", ") : "none on the pr report" }
      : {
          name: "browser, iOS and Android media attached",
          ok: missing.length === 0,
          detail: missing.length === 0 ? files.join(", ") : `missing ${missing.join(", ")}`,
        },
    ...(variant === "devices" ? [distinctCaptures(media)] : []),
    {
      name: "factory-verify passed at the head",
      ok: Boolean(evidence?.clean && evidence.producer === "agent" && evidence.checks.length > 0 && failedChecks.length === 0),
      detail: evidence
        ? `${evidence.producer}, ${evidence.clean ? "clean" : "dirty"}, ${evidence.checks.map((c) => `${c.name} ${c.exitCode}`).join(", ")}`
        : `no evidence for ${head?.sha.slice(0, 7) ?? "the head"}`,
    },
    {
      name: "handed over, not merged",
      ok: decision?.outcome === "handover" && !decision.merged,
      detail: decision ? `${decision.outcome}: ${decision.reasons.join(" ")}` : "no decision yet",
    },
  ];
}
