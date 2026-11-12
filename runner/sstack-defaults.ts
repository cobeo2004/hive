import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { sstackDefaults } from "../db/schema";
import { patch } from "../lib/toml-patch";
import { message } from "./queue";
import { workflowDeps } from "./workflow-pr";

// The Hive-wide `~/.sstack` defaults (Q37): a save checks them with sstack-doctor on a temporary copy before the one
// "factory" row changes; every runner's tick writes the row to its own ~/.sstack, runs doctor there and puts the old
// files back if doctor refuses. Only config.toml, roles and step.toml are written, never hooks or a runner's own
// `[overnight]`. Save waits for `sstack_defaults` in the intent_kind enum, so the caller runs saveDefaults. Runs under Bun.

declare const Bun: { TOML: { parse(text: string): unknown } }; // no bun-types in tsc

/** Where defaults live and how they are checked; regressions swap in a temporary home and a fake doctor. */
export const defaultsDeps = {
  home: homedir(), // the directory holding `.sstack`
  dir: tmpdir(),
  doctor: (cwd: string, env: Record<string, string>) => workflowDeps.doctor(cwd, env),
  now: () => new Date(),
};

// ponytail: nothing enforces a single row (R37 follow-up), so only id "factory" counts; any other row is ignored.
const FACTORY = "factory";
// WRITABLE of runner/workflow-pr.ts without `.sstack/`: no segment starts with a dot, so `..` cannot climb out.
const PATHS = /^(config\.toml|roles\/[\w-][\w.-]*\.toml|steps\/[\w-][\w.-]*\/step\.toml)$/;
const sstackDir = () => join(defaultsDeps.home, ".sstack");
/** A symlinked ~/.sstack itself (dotfiles) is fine: writes land in its real directory. Only links below it are refused. */
const sstackRoot = async () => (await missing(realpath(sstackDir()))) ?? sstackDir();

type Files = Record<string, string>;
type DefaultsStatus = { sha: string } | { error: string };
let status: DefaultsStatus | undefined;
/** The sha whose last apply failed here: not retried every tick, a new sha is. */
let failedSha: string | undefined;

export const defaultsStatus = () => status;

const shaOf = (files: Files) =>
  createHash("sha256")
    .update(JSON.stringify(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : 1))))
    .digest("hex");

const missing = <T>(op: Promise<T>) =>
  op.catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });
const read = (path: string) => missing(readFile(path, "utf8"));

/** Throws when `path`, or any directory between `root` and it, is a symlink; a missing path is fine. */
async function noLinks(root: string, path: string) {
  let at = root;
  for (const part of relative(root, path).split("/")) {
    at = join(at, part);
    const stat = await missing(lstat(at));
    if (!stat) return;
    if (stat.isSymbolicLink()) throw new Error(`${at} is a symlink; refusing to write through it`);
  }
}

const put = async (path: string, text: string) => {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text);
};

function validate(files: Files) {
  const entries = Object.entries(files ?? {});
  if (!entries.length) throw new Error("no files to save");
  for (const [path, text] of entries) {
    if (!PATHS.test(path)) throw new Error(`${path} is not a defaults file`);
    if (typeof text !== "string") throw new Error(`${path} must be text`);
  }
  if (Object.hasOwn(Bun.TOML.parse(files["config.toml"] ?? "") as object, "overnight"))
    throw new Error("config.toml must not set [overnight]: each runner keeps its own");
}

/** The text to write: config.toml keeps this runner's `[overnight]` scalars, everything else is as saved. */
function render(path: string, text: string, onDisk: string | undefined) {
  if (path !== "config.toml" || onDisk === undefined) return text;
  const local = (Bun.TOML.parse(onDisk) as { overnight?: unknown }).overnight;
  if (local === undefined) return text;
  if (typeof local !== "object" || local === null || Array.isArray(local) || local instanceof Date) throw new Error("[overnight] is not a table here");
  let out = text;
  // ponytail: scalar [overnight] keys only; a nested table, array or date there is an error and the old files stay.
  for (const [key, value] of Object.entries(local)) {
    if (typeof value !== "string" && typeof value !== "number" && typeof value !== "boolean") throw new Error(`[overnight] ${key} is not a scalar`);
    out = patch(out, "overnight", key, value);
  }
  return out;
}

/** Checks the files with doctor on a temporary copy of ~/.sstack; only a pass replaces the row. Returns the new sha. */
export async function saveDefaults({ files, by }: { files: Files; by: string }) {
  validate(files);
  const tmp = await mkdtemp(join(defaultsDeps.dir, "hive-defaults-"));
  try {
    const root = await sstackRoot();
    for (const path of Object.keys(files)) await noLinks(root, join(root, path));
    // Links are copied as links, never followed; noLinks already refused every path a write could go through.
    await missing(cp(root, tmp, { recursive: true }));
    for (const [path, text] of Object.entries(files)) await put(join(tmp, path), render(path, text, await read(join(tmp, path))));
    const { code, output } = await defaultsDeps.doctor(tmp, { SSTACK_HOME: tmp });
    if (code !== 0) throw new Error(`sstack-doctor failed (exit ${code}):\n${output}`);
    const row = { files, sha: shaOf(files), updated_at: defaultsDeps.now(), updated_by: by };
    await db
      .insert(sstackDefaults)
      .values({ id: FACTORY, ...row })
      .onConflictDoUpdate({ target: sstackDefaults.id, set: row });
    return { sha: row.sha };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

/**
 * Brings this runner's ~/.sstack to the row. Only differing files are written, so a second tick or a restart writes
 * nothing and runs no doctor. A doctor failure puts every touched file back.
 * ponytail: roles and steps removed from the defaults stay on runners, and a failed new step leaves its empty directory.
 */
export async function syncDefaults() {
  const [row] = await db.select().from(sstackDefaults).where(eq(sstackDefaults.id, FACTORY));
  if (!row) return { skipped: "no defaults" };
  const sha = row.sha ?? shaOf(row.files);
  if (sha === failedSha) return { skipped: "failed" };

  const before = new Map<string, string | undefined>(); // files this tick started writing, with their old text
  let root = sstackDir();
  try {
    root = await sstackRoot();
    validate(row.files);
    const wanted = new Map<string, string>();
    for (const [path, text] of Object.entries(row.files)) {
      const disk = await read(join(root, path));
      const want = render(path, text, disk);
      if (disk !== want) wanted.set(path, want);
    }
    if (wanted.size) {
      for (const path of wanted.keys()) await noLinks(root, join(root, path));
      for (const [path, text] of wanted) {
        before.set(path, await read(join(root, path)));
        await put(join(root, path), text);
      }
      const { code, output } = await defaultsDeps.doctor(root, { SSTACK_HOME: root });
      if (code !== 0) throw new Error(`sstack-doctor failed (exit ${code}):\n${output}`);
    }
    failedSha = undefined;
    status = { sha };
    return { written: [...wanted.keys()] };
  } catch (error) {
    // Each file is restored on its own, and the sha is marked failed even when one cannot be, so it is not retried every tick.
    const restored = await Promise.allSettled(
      [...before].map(([path, text]) => (text === undefined ? rm(join(root, path), { force: true }) : put(join(root, path), text))),
    );
    const stuck = [...before.keys()].filter((_, i) => restored[i]?.status === "rejected");
    failedSha = sha;
    status = { error: (message(error) + (stuck.length ? ` (could not restore ${stuck.join(", ")})` : "")).slice(-2000) };
    return { failed: sha };
  }
}
