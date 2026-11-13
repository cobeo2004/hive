import { z } from "zod";
import { matchesAny } from "./globs";

// Media the agent attaches to its pr assessment, so the owner sees what the agent saw: images and
// videos from its run's media folder (<git toplevel>/.sstack/runs/<run>/media/). The assessment names
// files by basename; the reporter (hooks/report.ts under Claude Code, mcp/factory-report.ts elsewhere)
// reads each one (lib/media-files.ts) and sends it as a screenshot event ahead of the stage event. Ingest
// keeps the bytes in job_media, keyed by that stage event and the file, and the panel serves them to the owner.

/** Where a run's files live under the repo's git toplevel: `<RUNS_DIR>/<run>/media/<file>`. */
export const RUNS_DIR = ".sstack/runs";
export const MAX_MEDIA = 6;
/** Per image, before base64; a 1280×720 PNG is usually well under it. */
export const MAX_IMAGE_BYTES = 1_000_000;
/** Per video, before base64. */
export const MAX_VIDEO_BYTES = 25_000_000;
const MAX_DATA_CHARS = Math.ceil(MAX_VIDEO_BYTES / 3) * 4;

export const MEDIA_TYPES = ["image/png", "image/jpeg", "image/webp", "video/mp4", "video/quicktime"] as const;
export type MediaType = (typeof MEDIA_TYPES)[number];

export const mediaRefSchema = z.object({
  file: z
    .string()
    .regex(/^[^/\\]+$/)
    .refine((f) => f !== "." && f !== "..")
    .max(200)
    .describe("The file's name in your run's media folder, e.g. after-list.png or after-list.mp4."),
  caption: z.string().min(1).max(300).describe("What it shows: the page, the state, and what to look for."),
});
export type MediaRef = z.infer<typeof mediaRefSchema>;

export const mediaInputSchema = z.array(mediaRefSchema).max(MAX_MEDIA);

/** What a screenshot event carries besides the event's own id, session and time; it carries an image or a video. */
export const mediaShape = {
  jobKey: z.string().min(1),
  /** The pr stage event whose assessment names this file. */
  stageEventId: z.string().min(1),
  file: mediaRefSchema.shape.file,
  contentType: z.enum(MEDIA_TYPES),
  /** The file, base64. */
  data: z.base64().max(MAX_DATA_CHARS),
};

/** Whether an event's file is within the limit for its kind; the base64 length gives its byte size exactly. */
export const withinLimit = ({ contentType, data }: { contentType: MediaType; data: string }) =>
  (data.length * 3) / 4 - (data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0) <= (contentType.startsWith("image/") ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES);

const KINDS = { png: "image", jpg: "image", jpeg: "image", webp: "image", mp4: "video", mov: "video" } as const;

/** What a file's extension says it is; null when it is none the panel shows. */
export const mediaKind = (file: string): "image" | "video" | null => KINDS[file.split(".").pop()?.toLowerCase() as keyof typeof KINDS] ?? null;

/** The type its first bytes name; null when it is none the panel shows. */
export function sniffType(bytes: Uint8Array): MediaType | null {
  const starts = (...sig: number[]) => sig.every((b, i) => bytes[i] === b);
  const at = (from: number, to: number) => String.fromCharCode(...bytes.slice(from, to));
  if (starts(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  if (starts(0xff, 0xd8, 0xff)) return "image/jpeg";
  if (starts(0x52, 0x49, 0x46, 0x46) && at(8, 12) === "WEBP") return "image/webp";
  if (at(4, 8) === "ftyp") return at(8, 12) === "qt  " ? "video/quicktime" : "video/mp4";
  return null;
}

/** Where the panel serves one of the current assessment's media; `v` changes with each report, so a cached image never outlives it. */
export const mediaUrl = (jobKey: string, index: number, reportId: string | null) =>
  `/api/jobs/${encodeURIComponent(jobKey)}/media/${index}?v=${encodeURIComponent(reportId ?? "")}`;

/** Files whose change shows on a page or screen. */
const UI_GLOBS = ["**/*.tsx", "**/*.jsx", "**/*.vue", "**/*.svelte", "**/*.astro", "**/*.html", "**/*.css", "**/*.scss", "**/*.sass", "**/*.less"];

/** The changed files a merge should have media for. */
export const uiFiles = (paths: readonly string[]) => paths.filter((path) => matchesAny(path, UI_GLOBS));

const SECTION_START = "<!-- sstack-media -->";
const SECTION_END = "<!-- /sstack-media -->";

/** Whether a PR body has the Before and After section `sstack-pr-media --edit-body` writes, with something in it. */
export function hasMediaSection(body: string) {
  const start = body.indexOf(SECTION_START);
  const end = start < 0 ? -1 : body.indexOf(SECTION_END, start);
  return end >= 0 && body.slice(start + SECTION_START.length, end).trim() !== "";
}
