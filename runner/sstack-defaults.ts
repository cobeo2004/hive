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

// The Hive-wide `~/.sstack` defaults (Q37): a save checks them with sstack-doctor on a temporary copy before the
// one "factory" row changes; every runner's tick then writes the row to its own ~/.sstack, runs doctor there and
// puts the old files back if doctor refuses. Only config.toml, roles and step.toml files are ever written, never
// hooks, and never a runner's own `[overnight]` table. Hooking Save to an intent waits for `sstack_defaults`
// in the intent_kind enum, so the caller runs saveDefaults. Runs under Bun (the runner), not the Node panel.

declare const Bun: { TOML: { parse(text: string): unknown } }; // no bun-types in tsc

/** Where defaults live and how they are checked; regressions swap in a temporary home and a fake doctor. */
export const defaultsDeps: {
  /** The directory holding `.sstack`. */
  home: string;
  dir: string;
  doctor: (cwd: string, env: Record<string, string>) => Promise<{ code: number; output: string }>;
  now: () => Date;
} = {
  home: homedir(),
  dir: tmpdir(),
  doctor: (cwd, env) => workflowDeps.doctor(cwd, env),
  now: () => new Date(),
};

// ponytail: nothing enforces a single row (R37 follow-up), so only id "factory" counts; any other row is ignored.
const FACTORY = "factory";
// WRITABLE of runner/workflow-pr.ts without the `.sstack/` prefix: no segment starts with a dot, so `..` cannot climb out.
const PATHS = /^(config\.toml|roles\/[\w-][\w.-]*\.toml|steps\/[\w-][\w.-]*\/step\.toml)$/;
const sstackDir = () => join(defaultsDeps.home, ".sstack");
/** A symlinked ~/.sstack itself (dotfiles) is fine: writes land in its real directory. Only links below it are refused. */
const sstackRoot = () =>
  realpath(sstackDir()).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return sstackDir();
    throw error;
  });

type Files = Record<string, string>;
export type DefaultsStatus = { sha: string } | { error: string };
let status: DefaultsStatus | undefined;
/** The sha whose last apply failed here; a row with that sha is not retried every tick, a new one is. */
let failedSha: string | undefined;

/** What the heartbeat reports: the applied sha, this runner's error, or nothing yet. */
export const defaultsStatus = () => status;

const shaOf = (files: Files) =>
  createHash("sha256")
    .update(
      JSON.stringify(
        Object.keys(files)
          .sort()
          .map((path) => [path, files[path]]),
      ),
    )
    .digest("hex");

const read = (path: string) =>
  readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT") return undefined;
    throw error;
  });

/** Throws when `path`, or any directory between `root` and it, is a symlink; a missing path is fine. */
async function noLinks(root: string, path: string) {
  let at = root;
  for (const part of relative(root, path).split("/")) {
    at = join(at, part);
    const stat = await lstat(at).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return undefined;
      throw error;
    });
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
  const config = files["config.toml"];
  if (config !== undefined && Object.hasOwn(Bun.TOML.parse(config) as object, "overnight")) {
    throw new Error("config.toml must not set [overnight]: each runner keeps its own");
  }
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
    await cp(root, tmp, { recursive: true }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
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
 * Brings this runner's ~/.sstack to the row. Only files that differ are written, so a second tick, or a restart,
 * writes nothing and runs no doctor. A doctor failure puts every touched file back.
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
      if (disk === want) continue;
      wanted.set(path, want);
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
    const stuck: string[] = [];
    for (const [path, text] of before) {
      try {
        await (text === undefined ? rm(join(root, path), { force: true }) : put(join(root, path), text));
      } catch {
        stuck.push(path);
      }
    }
    failedSha = sha;
    status = { error: (message(error) + (stuck.length ? ` (could not restore ${stuck.join(", ")})` : "")).slice(-2000) };
    return { failed: sha };
  }
}
