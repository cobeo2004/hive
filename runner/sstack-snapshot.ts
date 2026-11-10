import { eq } from "drizzle-orm";
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

const WANTED = /^\.sstack\/(config\.toml|project\.toml|roles\/[^/]+\.toml|steps\/[^/]+\/step\.toml)$/;

type Snapshot = { repo: string; skipped: "no checkout" } | { repo: string; sha: string; unchanged: true } | { repo: string; sha: string; files: number };

/**
 * Stores the `.sstack/` files of the repo's origin/main in `repo_sstack_config`; a snapshot at the
 * sha already stored writes nothing. Throws when git fails, so callers catch.
 */
export async function snapshotSstack(repo: string): Promise<Snapshot> {
  const cwd = await snapshotDeps.checkout(repo);
  if (!cwd) return { repo, skipped: "no checkout" };

  // Output is used as git prints it: `git show` text must not be trimmed.
  const git = async (args: string[]) => (await snapshotDeps.host.run("git", args, { cwd, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout;
  await git(["fetch", "origin", "main"]).catch(() => ""); // best effort: a stale origin/main is still a consistent snapshot
  const sha = (await git(["rev-parse", "origin/main"])).trim();

  const [stored] = await db.select({ sha: repoSstackConfig.sha }).from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo));
  if (stored?.sha === sha) return { repo, sha, unchanged: true };

  // Read at the resolved sha, so a fetch that lands meanwhile cannot mix two commits.
  const paths = (await git(["ls-tree", "-r", "-z", "--name-only", sha, "--", ".sstack"])).split("\0").filter((path) => WANTED.test(path));
  const files = Object.fromEntries(await Promise.all(paths.map(async (path) => [path, await git(["show", `${sha}:${path}`])] as const)));

  const read_at = snapshotDeps.now();
  await db.insert(repoSstackConfig).values({ repo, files, sha, read_at }).onConflictDoUpdate({ target: repoSstackConfig.repo, set: { files, sha, read_at } });
  return { repo, sha, files: paths.length };
}
