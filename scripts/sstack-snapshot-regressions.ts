import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { repoSstackConfig } = await import("../db/schema");
const { snapshotDeps, snapshotSstack } = await import("../runner/sstack-snapshot");

const SSTACK = "acme/sstack";
const BARE = "acme/bare";
const NONE = "acme/none";

const root = mkdtempSync(join(tmpdir(), "hive-sstack-snapshot-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync("git", ["-c", "user.name=regression", "-c", "user.email=regression@example.com", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
  }).trim();

/** Writes the files, commits them and points origin/main at the commit, as a fetch would. */
function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  git(cwd, "update-ref", "refs/remotes/origin/main", "HEAD");
  return git(cwd, "rev-parse", "HEAD");
}

const repoDir = join(root, "sstack");
const bareDir = join(root, "bare");
for (const dir of [repoDir, bareDir]) {
  mkdirSync(dir);
  git(dir, "init", "-q");
}

// Text kept exactly: no trailing newline on one file, CRLF and trailing blank lines on another.
const WANTED = {
  ".sstack/config.toml": "workflow = 'default'\n",
  ".sstack/project.toml": "[test.mobile]\nplatform = 'ios'\n\n\n",
  ".sstack/roles/a.toml": "name = 'a'",
  ".sstack/steps/plan/step.toml": "id = 'plan'\r\n",
};
const first = commit(
  repoDir,
  {
    ...WANTED,
    // Decoys the snapshot must leave out.
    ".sstack/runs/x/plan.md": "# a run\n",
    ".sstack/roles/nested/b.toml": "name = 'b'\n",
    ".sstack/steps/plan/notes.md": "notes\n",
    "README.md": "readme\n",
  },
  "first",
);
commit(bareDir, { "README.md": "no sstack here\n" }, "only");

snapshotDeps.checkout = async (repo) => (repo === SSTACK ? repoDir : repo === BARE ? bareDir : null);
const rowOf = async (repo: string) => (await db.select().from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo)))[0];

try {
  // 1. a snapshot holds the wanted files, as exact text, with main's sha
  const one = await snapshotSstack(SSTACK);
  assert.deepEqual(one, { repo: SSTACK, sha: first, files: 4 });
  const row1 = (await rowOf(SSTACK))!;
  assert.deepEqual(row1.files, WANTED, "only config, project, roles/*.toml and steps/*/step.toml, untrimmed");
  assert.equal(row1.sha, first);

  // 2. the same sha writes nothing
  const again = await snapshotSstack(SSTACK);
  assert.deepEqual(again, { repo: SSTACK, sha: first, unchanged: true });
  const row2 = (await rowOf(SSTACK))!;
  assert.equal(row2.read_at.getTime(), row1.read_at.getTime(), "an unchanged sha leaves read_at alone");

  // 3. a new sha replaces the row
  const second = commit(repoDir, { ".sstack/config.toml": "workflow = 'fast'\n" }, "second");
  assert.notEqual(second, first);
  assert.deepEqual(await snapshotSstack(SSTACK), { repo: SSTACK, sha: second, files: 4 });
  const row3 = (await rowOf(SSTACK))!;
  assert.equal(row3.sha, second);
  assert.equal(row3.files[".sstack/config.toml"], "workflow = 'fast'\n");
  assert.equal((await db.select().from(repoSstackConfig).where(eq(repoSstackConfig.repo, SSTACK))).length, 1, "one row per repo");

  // 4. a repo with no .sstack/ stores an empty object
  const bareSha = git(bareDir, "rev-parse", "HEAD");
  assert.deepEqual(await snapshotSstack(BARE), { repo: BARE, sha: bareSha, files: 0 });
  const bare = (await rowOf(BARE))!;
  assert.deepEqual(bare.files, {});
  assert.equal(bare.sha, bareSha);

  // a repo this machine has no checkout of is skipped and writes nothing
  assert.deepEqual(await snapshotSstack(NONE), { repo: NONE, skipped: "no checkout" });
  assert.equal(await rowOf(NONE), undefined);

  console.log("sstack-snapshot regressions passed");
} finally {
  rmSync(root, { recursive: true, force: true });
  await db.delete(repoSstackConfig).where(inArray(repoSstackConfig.repo, [SSTACK, BARE, NONE]));
  process.exit(process.exitCode ?? 0);
}
