import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { repoSstackConfig } from "../db/schema";
import { type JobHost, localHost } from "../lib/host";
import { factoryCheckouts } from "./ops";

// Hive keeps a copy of each repo's sstack config as it is on main, so the panel never touches git.
// The runner reads it from this machine's checkout after onboarding and after merges to main.

/** Where snapshots read; regressions point the checkout at a fixture repo. */
export const snapshotDeps: {
  host: JobHost;
  checkout: (repo: string) => Promise<string | null>;
  now: () => Date;
} = {
  host: localHost,
  checkout: async (repo) => (await factoryCheckouts()).get(repo) ?? null,
  now: () => new Date(),
};

const WANTED = /^\.sstack\/(config\.toml|project\.toml|roles\/[^/]+\.toml|steps\/[^/]+\/step\.toml|wiki\/[^/]+\.md)$/;

/** Wiki pages are repo-written prose sent whole to the panel: a page over this, or past the total, is left out. */
export const WIKI_FILE_MAX = 256 * 1024;
export const WIKI_TOTAL_MAX = 2 * 1024 * 1024;

type Snapshot = { repo: string; skipped: "no checkout" } | { repo: string; sha: string; unchanged: true } | { repo: string; sha: string; files: number };

/**
 * Stores the `.sstack/` files of the repo's origin/main in `repo_sstack_config`; a snapshot at the
 * sha already stored writes nothing. Throws when git fails, so callers catch.
 */
export async function snapshotSstack(repo: string): Promise<Snapshot> {
  const cwd = await snapshotDeps.checkout(repo);
  if (!cwd) return { repo, skipped: "no checkout" };

  // ponytail: serialized per repo through the database, so runners on several machines also queue; each machine reads its own checkout's origin/main.
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${"hive sstack-snapshot " + repo}))`);

    // Output is used as git prints it: `git show` text must not be trimmed.
    const git = async (args: string[]) => (await snapshotDeps.host.run("git", args, { cwd, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
    // A failed fetch aborts, so an offline checkout never overwrites a newer snapshot with its stale origin/main.
    await git(["fetch", "origin", "main"]);
    const sha = (await git(["rev-parse", "origin/main"])).trim();

    const [stored] = await tx.select({ sha: repoSstackConfig.sha }).from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo));
    if (stored?.sha === sha) return { repo, sha, unchanged: true as const };

    // Read at the resolved sha, so a fetch that lands meanwhile cannot mix two commits.
    // `-l` gives each blob's size, so an oversized wiki page is never read. Lines are `<mode> <type> <object> <size>\t<path>`.
    const entries = (await git(["ls-tree", "-r", "-z", "-l", sha, "--", ".sstack"]))
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        return { path: line.slice(tab + 1), size: Number(line.slice(0, tab).trim().split(/\s+/)[3]) };
      })
      .filter(({ path }) => WANTED.test(path));
    let wikiBytes = 0;
    // ponytail: a dropped page shows as a broken link in the graph; say why in the panel if that confuses anyone.
    const paths = entries
      .filter(({ path, size }) => {
        if (!path.startsWith(".sstack/wiki/")) return true;
        if (!(size <= WIKI_FILE_MAX) || wikiBytes + size > WIKI_TOTAL_MAX) return false;
        wikiBytes += size;
        return true;
      })
      .map(({ path }) => path);
    const files: Record<string, string> = {};
    for (const path of paths) files[path] = await git(["show", `${sha}:${path}`]);

    const read_at = snapshotDeps.now();
    await tx.insert(repoSstackConfig).values({ repo, files, sha, read_at }).onConflictDoUpdate({ target: repoSstackConfig.repo, set: { files, sha, read_at } });
    return { repo, sha, files: paths.length };
  });
}
