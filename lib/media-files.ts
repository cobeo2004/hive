import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import { MAX_IMAGE_BYTES, MAX_VIDEO_BYTES, mediaKind, RUNS_DIR, sniffType, type MediaRef, type MediaType } from "./media";

// The reporter's side of lib/media.ts: reading the attached files on the agent's machine.

export type ReadMedia = { ok: true; bytes: Buffer; contentType: MediaType } | { ok: false; reason: string };

/** The folder holding the repo's runs: under the git toplevel of `cwd`, or `cwd` itself outside a repo. */
export function runsRoot(cwd: string): string {
  try {
    const top = execFileSync("git", ["-C", cwd, "rev-parse", "--show-toplevel"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return join(top, RUNS_DIR);
  } catch {
    return join(cwd, RUNS_DIR);
  }
}

const IMAGE_TYPES: Record<string, MediaType> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" };

const inside = (root: string, path: string) => {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

/** The newest `<root>/<run>/media/<file>` whose real path stays inside its own media folder; null when there is none. */
export function findMedia(file: string, root: string): string | null {
  let runs: string[];
  try {
    runs = readdirSync(root);
  } catch {
    return null;
  }
  let best: { path: string; mtime: number } | null = null;
  for (const run of runs) {
    try {
      const candidate = join(root, run, "media", file);
      if (!existsSync(candidate)) continue;
      const path = realpathSync(candidate);
      const media = realpathSync(join(root, run, "media"));
      if (!inside(realpathSync(root), media) || !inside(media, path)) continue;
      const mtime = statSync(path).mtimeMs;
      if (!best || mtime > best.mtime) best = { path, mtime };
    } catch {
      // A run folder that vanishes or can't be read holds nothing for us.
    }
  }
  return best?.path ?? null;
}

/** Reads one attached file from the runs under `root`, refusing one that is missing, too large, or not what its name says. */
export function readMedia(file: string, root: string): ReadMedia {
  const path = findMedia(file, root);
  if (!path) return { ok: false, reason: `${file} is not in any ${root}/*/media/` };
  const kind = mediaKind(file);
  if (!kind) return { ok: false, reason: `${file} is not a png, jpg, webp, mp4 or mov file` };
  const limit = kind === "video" ? MAX_VIDEO_BYTES : MAX_IMAGE_BYTES;
  const size = statSync(path).size;
  if (size > limit) return { ok: false, reason: `${file} is ${size} bytes, over the ${limit} limit for ${kind}s` };
  const bytes = readFileSync(path);
  const contentType = sniffType(bytes);
  const ext = file.split(".").pop()!.toLowerCase();
  // Images must be the exact type their extension names; a video's .mov or .mp4 may carry either brand.
  const ok = kind === "video" ? contentType?.startsWith("video/") : contentType === IMAGE_TYPES[ext];
  if (!contentType || !ok) return { ok: false, reason: `${file} is not the ${ext} it is named` };
  return { ok: true, bytes, contentType };
}

/** Every attached file that can't be sent, as one reason each. */
export const unreadable = (refs: readonly MediaRef[], root: string) =>
  refs.flatMap((ref) => {
    const read = readMedia(ref.file, root);
    return read.ok ? [] : [read.reason];
  });

type MediaEventFields = { kind: "screenshot"; jobKey: string; stageEventId: string; file: string; contentType: MediaType; data: string };

/**
 * The screenshot events for one pr report (one per image or video), each with an id derived from the
 * stage event and the file, so a retried report stores each file once. Files that can't be read are left out.
 */
export function mediaEvents(
  refs: readonly MediaRef[],
  { jobKey, stageEventId, sessionId, at }: { jobKey: string; stageEventId: string; sessionId: string; at: number },
  root: string,
): (MediaEventFields & { eventId: string; sessionId: string; at: number })[] {
  return [...new Set(refs.map((r) => r.file))].flatMap((file) => {
    const read = readMedia(file, root);
    if (!read.ok) return [];
    return [
      {
        eventId: `screenshot:${stageEventId}:${file}`,
        sessionId,
        at,
        kind: "screenshot" as const,
        jobKey,
        stageEventId,
        file,
        contentType: read.contentType,
        data: read.bytes.toString("base64"),
      },
    ];
  });
}
