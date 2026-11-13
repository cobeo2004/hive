import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { repoSstackConfig } = await import("../db/schema");
const { snapshotDeps, snapshotSstack, WIKI_FILE_MAX, WIKI_TOTAL_MAX } = await import("../runner/sstack-snapshot");

const SSTACK = "acme/sstack";
const BARE = "acme/bare";
const NONE = "acme/none";

const root = mkdtempSync(join(tmpdir(), "hive-sstack-snapshot-"));
const git = (cwd: string, ...args: string[]) =>
  execFileSync(
    "git",
    ["-c", "core.autocrlf=false", "-c", "user.name=regression", "-c", "user.email=regression@example.com", "-c", "commit.gpgsign=false", ...args],
    {
      cwd,
      encoding: "utf8",
    },
  ).trim();

/** Writes the files, commits them and pushes to the fixture's origin, so the runner's fetch finds them. */
function commit(cwd: string, files: Record<string, string>, message: string) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(cwd, path)), { recursive: true });
    writeFileSync(join(cwd, path), text);
  }
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", message);
  git(cwd, "push", "-q", "origin", "HEAD:refs/heads/main");
  return git(cwd, "rev-parse", "HEAD");
}

const repoDir = join(root, "sstack");
const bareDir = join(root, "bare");
// Each fixture has a real remote: a bare repo the runner's `git fetch origin main` reads.
for (const dir of [repoDir, bareDir]) {
  const remote = `${dir}.git`;
  mkdirSync(dir);
  mkdirSync(remote);
  git(remote, "init", "-q", "--bare", "-b", "main");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
}

// Text kept exactly: no trailing newline on one file, CRLF and trailing blank lines on another.
const WANTED = {
  ".sstack/config.toml": "workflow = 'default'\n",
  ".sstack/project.toml": "[test.mobile]\nplatform = 'ios'\n\n\n",
  ".sstack/roles/a.toml": "name = 'a'",
  ".sstack/steps/plan/step.toml": "id = 'plan'\r\n",
  // The wiki (R41): three linked pages and the generated index.
  ".sstack/wiki/index.md": "# Wiki index\n\n- [a](a.md) — A\n- [b](b.md) — B\n- [c](c.md) — C\n",
  ".sstack/wiki/a.md": "---\nsummary: A\n---\n\nSee [b](b.md).\n",
  ".sstack/wiki/b.md": "---\nsummary: B\n---\n\nSee [c](c.md).\n",
  ".sstack/wiki/c.md": "---\nsummary: C\n---\n\nSee [a](a.md).\n",
};
const first = commit(
  repoDir,
  {
    ...WANTED,
    // Decoys the snapshot must leave out.
    ".sstack/runs/x/plan.md": "# a run\n",
    ".sstack/roles/nested/b.toml": "name = 'b'\n",
    ".sstack/steps/plan/notes.md": "notes\n",
    ".sstack/wiki/nested/d.md": "nested\n",
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
  assert.deepEqual(one, { repo: SSTACK, sha: first, files: 8 });
  const row1 = (await rowOf(SSTACK))!;
  assert.deepEqual(row1.files, WANTED, "only config, project, roles/*.toml, steps/*/step.toml and wiki/*.md, untrimmed");
  assert.equal(row1.sha, first);

  // 2. the same sha writes nothing
  const again = await snapshotSstack(SSTACK);
  assert.deepEqual(again, { repo: SSTACK, sha: first, unchanged: true });
  const row2 = (await rowOf(SSTACK))!;
  assert.equal(row2.read_at.getTime(), row1.read_at.getTime(), "an unchanged sha leaves read_at alone");

  // 3. a new sha replaces the row
  const second = commit(repoDir, { ".sstack/config.toml": "workflow = 'fast'\n" }, "second");
  assert.notEqual(second, first);
  assert.deepEqual(await snapshotSstack(SSTACK), { repo: SSTACK, sha: second, files: 8 });
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

  // 5. two snapshots fired together run one after the other: the second finds the sha already stored
  const third = commit(repoDir, { ".sstack/config.toml": "workflow = 'slow'\n" }, "third");
  const both = await Promise.all([snapshotSstack(SSTACK), snapshotSstack(SSTACK)]);
  assert.equal((await rowOf(SSTACK))!.sha, third, "the row holds the newest commit");
  assert.equal((await db.select().from(repoSstackConfig).where(eq(repoSstackConfig.repo, SSTACK))).length, 1, "still one row");
  assert.equal(both.filter((result) => "unchanged" in result).length, 1, "the queued duplicate is a no-op, which only holds if they were serialized");

  // 6. a failed fetch aborts and writes nothing, even though the cached origin/main holds a newer commit than the row
  const fourth = commit(repoDir, { ".sstack/config.toml": "workflow = 'newer'\n" }, "fourth");
  const before = (await rowOf(SSTACK))!;
  const remote = git(repoDir, "remote", "get-url", "origin");
  git(repoDir, "remote", "set-url", "origin", "/nonexistent");
  try {
    await assert.rejects(snapshotSstack(SSTACK), "an offline checkout must not snapshot its stale origin/main");
  } finally {
    git(repoDir, "remote", "set-url", "origin", remote);
  }
  const after = (await rowOf(SSTACK))!;
  assert.equal(after.sha, before.sha, "the row keeps its sha");
  assert.equal(after.read_at.getTime(), before.read_at.getTime(), "the row keeps its read_at");
  assert.deepEqual(await snapshotSstack(SSTACK), { repo: SSTACK, sha: fourth, files: 8 }, "with the remote back, the snapshot lands");

  // 7. wiki pages are bounded: one over the per-page cap is left out, and pages past the total cap are too
  const big = "x".repeat(WIKI_FILE_MAX + 1);
  const fill = "y".repeat(WIKI_FILE_MAX);
  const fillers = Object.fromEntries(Array.from({ length: WIKI_TOTAL_MAX / WIKI_FILE_MAX + 1 }, (_, i) => [`.sstack/wiki/f${i}.md`, fill]));
  commit(repoDir, { ".sstack/wiki/big.md": big, ...fillers }, "big wiki");
  await snapshotSstack(SSTACK);
  const bounded = (await rowOf(SSTACK))!.files;
  assert.equal(bounded[".sstack/wiki/big.md"], undefined, "a page over WIKI_FILE_MAX is not stored");
  const wikiBytes = Object.entries(bounded)
    .filter(([path]) => path.startsWith(".sstack/wiki/"))
    .reduce((sum, [, text]) => sum + Buffer.byteLength(text), 0);
  assert.ok(wikiBytes <= WIKI_TOTAL_MAX, `wiki total ${wikiBytes} stays within WIKI_TOTAL_MAX`);
  assert.equal(bounded[".sstack/config.toml"], "workflow = 'newer'\n", "config files are still stored");

  console.log("sstack-snapshot regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
  await db.delete(repoSstackConfig).where(inArray(repoSstackConfig.repo, [SSTACK, BARE, NONE]));
  process.exit(process.exitCode ?? 0);
}
