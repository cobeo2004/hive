import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { repoSettings, repoSstackConfig } from "../db/schema";
import { mainReader } from "../lib/github/installation";
import type { RepoName } from "../lib/github/app";
import { type JobHost, localHost } from "../lib/host";
import { factoryCheckouts } from "./ops";

// Hive keeps a copy of each repo's sstack config as it is on main, so the panel never touches git.
// The runner reads it from this machine's checkout (or GitHub) after onboarding, after merges to main, and every few minutes.

type Entry = { path: string; size: number; id: string };
/** One way to read main: this machine's checkout, or GitHub for a repo it has none of. */
type MainReader = { head: () => Promise<string>; tree: (sha: string) => Promise<Entry[]>; read: (sha: string, entry: Entry) => Promise<string> };

/** Where snapshots read; regressions point the checkout at a fixture repo and stub GitHub. */
export const snapshotDeps: {
  host: JobHost;
  checkout: (repo: string) => Promise<string | null>;
  github: (repo: string) => MainReader;
  now: () => Date;
} = {
  host: localHost,
  checkout: async (repo) => (await factoryCheckouts()).get(repo) ?? null,
  github: (repo) => mainReader(repo as RepoName),
  now: () => new Date(),
};

function checkoutReader(cwd: string): MainReader {
  // Output is used as git prints it: `git show` text must not be trimmed.
  const git = async (args: string[]) => (await snapshotDeps.host.run("git", args, { cwd, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  return {
    // A failed fetch aborts, so an offline checkout never overwrites a newer snapshot with its stale origin/main.
    head: async () => {
      await git(["fetch", "origin", "main"]);
      return (await git(["rev-parse", "origin/main"])).trim();
    },
    // `-l` gives each blob's size, so an oversized wiki page is never read. Lines are `<mode> <type> <object> <size>\t<path>`.
    tree: async (sha) =>
      (await git(["ls-tree", "-r", "-z", "-l", sha, "--", ".sstack"]))
        .split("\0")
        .filter(Boolean)
        .map((line) => {
          const tab = line.indexOf("\t");
          const [, , id, size] = line.slice(0, tab).trim().split(/\s+/);
          return { path: line.slice(tab + 1), size: Number(size), id };
        }),
    read: (sha, { path }) => git(["show", `${sha}:${path}`]),
  };
}

const WANTED = /^\.sstack\/(config\.toml|project\.toml|roles\/[^/]+\.toml|steps\/[^/]+\/step\.toml|wiki\/[^/]+\.md)$/;

/** Wiki pages are repo-written prose sent whole to the panel: a page over this, or past the total, is left out. */
export const WIKI_FILE_MAX = 256 * 1024;
export const WIKI_TOTAL_MAX = 2 * 1024 * 1024;

type Snapshot = { repo: string; busy: true } | { repo: string; sha: string; unchanged: true } | { repo: string; sha: string; files: number };

/**
 * Stores the `.sstack/` files of the repo's origin/main in `repo_sstack_config`; a snapshot at the
 * sha already stored writes nothing. Throws when reading main fails, so callers catch.
 */
export async function snapshotSstack(repo: string): Promise<Snapshot> {
  const cwd = await snapshotDeps.checkout(repo);
  // A repo onboarded in the cloud has no checkout on any runner; GitHub's copy of main is the same commit.
  const main = cwd ? checkoutReader(cwd) : snapshotDeps.github(repo);

  // One snapshot per repo at a time, across machines. A caller that finds one running skips rather than waits, so a slow
  // fetch never holds the serial queue (post-merge, onboarding); the running one, the next tick or the next sweep catches up.
  return db.transaction(async (tx) => {
    const lock = await tx.execute<{ locked: boolean }>(sql`select pg_try_advisory_xact_lock(hashtext(${"hive sstack-snapshot " + repo})) as locked`);
    if (!lock.rows[0]?.locked) return { repo, busy: true as const };
    const sha = await main.head();

    const [stored] = await tx.select({ sha: repoSstackConfig.sha }).from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo));
    if (stored?.sha === sha) return { repo, sha, unchanged: true as const };

    // Read at the resolved sha, so a fetch that lands meanwhile cannot mix two commits.
    const entries = (await main.tree(sha)).filter(({ path }) => WANTED.test(path));
    let wikiBytes = 0;
    // ponytail: a dropped page shows as a broken link in the graph; say why in the panel if that confuses anyone.
    const kept = entries.filter(({ path, size }) => {
      if (!path.startsWith(".sstack/wiki/")) return true;
      if (!(size <= WIKI_FILE_MAX) || wikiBytes + size > WIKI_TOTAL_MAX) return false;
      wikiBytes += size;
      return true;
    });
    const files: Record<string, string> = {};
    for (const entry of kept) files[entry.path] = await main.read(sha, entry);

    const read_at = snapshotDeps.now();
    await tx.insert(repoSstackConfig).values({ repo, files, sha, read_at }).onConflictDoUpdate({ target: repoSstackConfig.repo, set: { files, sha, read_at } });
    return { repo, sha, files: kept.length };
  });
}

const REFRESH_MS = 5 * 60_000;
let lastRefresh: number | undefined;
let refreshing = false;

/**
 * Snapshots every registered repo, at most once per REFRESH_MS per process, so a merge the runner
 * did not watch (the onboarding PR, a hand-merged `.sstack/` edit) still reaches the panel.
 * Returns only what changed or failed; undefined while throttled.
 */
export async function refreshSnapshots() {
  const now = snapshotDeps.now().getTime();
  // ponytail: a timer, not the push webhook, so it holds without webhooks; up to 5 min lag after a merge, react to repo_push intents if that matters.
  // A sweep still running (slow fetches) blocks the next, so two never overlap.
  if (refreshing || (lastRefresh !== undefined && now - lastRefresh < REFRESH_MS)) return undefined;
  lastRefresh = now;
  refreshing = true;
  try {
    return await sweep();
  } finally {
    refreshing = false;
  }
}

async function sweep() {
  const changed: string[] = [];
  const failed: { repo: string; error: string }[] = [];
  for (const { repo } of await db.select({ repo: repoSettings.repo }).from(repoSettings).orderBy(repoSettings.repo)) {
    try {
      if ("files" in (await snapshotSstack(repo))) changed.push(repo);
    } catch (error) {
      const message = (error instanceof Error ? error.message : String(error)).split("\n")[0];
      console.error(JSON.stringify({ event: "sstack-snapshot:refresh-failed", repo, error: message }));
      failed.push({ repo, error: message });
    }
  }
  return { changed, failed };
}
