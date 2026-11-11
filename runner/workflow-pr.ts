import { randomBytes } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExecError } from "../lib/exec";
import { BRANCH_PREFIX } from "../lib/factory";
import { installationTokens, type RepoName } from "../lib/github/app";
import { github } from "../lib/github/pulls";
import { localHost, type JobHost } from "../lib/host";
import type { Role } from "../lib/members";
import { factoryCheckouts } from "./ops";

// A Workflow save writes the proposed `.sstack/` files into a temporary worktree of origin/main
// and runs sstack-doctor there. A pass commits, pushes a unique `hive/workflow-<repo>-<stamp>`
// branch and opens a PR; a failure throws with doctor's output and pushes nothing. A smoke run
// is the doctor step alone. Hooking these to intents waits for `workflow_pr`/`workflow_smoke`
// in the intent_kind enum, so the caller stores the returned {url, branch}.

type Doctor = { code: number; output: string };

/** Where saves run; regressions swap in a fake host, token, checkout, doctor and GitHub client. */
export const workflowDeps: {
  host: JobHost;
  token: (repo: RepoName) => Promise<string>;
  checkout: (repo: RepoName) => Promise<string | null>;
  dir: string;
  remote: (repo: RepoName) => string;
  doctor: (cwd: string) => Promise<Doctor>;
  github: Pick<typeof github, "createPull">;
  now: () => Date;
} = {
  host: localHost,
  token: (repo) => installationTokens.get(repo),
  checkout: async (repo) => (await factoryCheckouts()).get(repo) ?? null,
  dir: tmpdir(),
  remote: (repo) => `https://github.com/${repo}.git`,
  // A non-zero exit is a result, not an error; a doctor that cannot start (ENOENT) rejects.
  async doctor(cwd) {
    try {
      const { stdout, stderr } = await workflowDeps.host.run(process.env.SSTACK_DOCTOR ?? "sstack-doctor", [], { cwd, timeoutMs: 120_000 });
      return { code: 0, output: stdout + stderr };
    } catch (error) {
      const { code, stdout = "", stderr = "" } = error as ExecError;
      if (typeof code === "number") return { code, output: stdout + stderr };
      throw error;
    }
  },
  github,
  now: () => new Date(),
};

// ponytail: copied from runner/post-merge.ts revertMerge; hoist to a shared lib when a third caller appears.
const TOKEN_ENV = "FACTORY_GIT_TOKEN";
const CREDENTIALS = [
  "-c",
  "credential.helper=",
  "-c",
  `credential.helper=!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${TOKEN_ENV}"; }; f`,
];
const IDENTITY = ["-c", "user.name=marshal-factory", "-c", "user.email=marshal-factory@users.noreply.github.com"];

// No path segment starts with a dot, so `..` cannot climb out of `.sstack/`.
const WRITABLE = /^\.sstack\/(config\.toml|roles\/[\w-][\w.-]*\.toml|steps\/[\w-][\w.-]*\/step\.toml)$/;

type Git = (args: string[], cwd?: string, env?: Record<string, string>) => Promise<string>;

/** Validates every file before touching git, then runs `work` in a throwaway worktree of origin/main with the files written. */
async function inWorktree<T>(repo: RepoName, files: Record<string, string>, work: (git: Git, dir: string, stamp: string) => Promise<T>) {
  const entries = Object.entries(files);
  if (!entries.length) throw new Error("no files to save");
  for (const [path, text] of entries) {
    if (!WRITABLE.test(path)) throw new Error(`${path} is not a workflow file`);
    if (typeof text !== "string") throw new Error(`${path} must be text`);
  }
  const checkout = await workflowDeps.checkout(repo);
  if (!checkout) throw new Error(`This machine has no checkout of ${repo}.`);

  const { host } = workflowDeps;
  const stamp = workflowDeps
    .now()
    .toISOString()
    .replace(/[-:]|\.\d+/g, "");
  const dir = join(workflowDeps.dir, `hive-workflow-${repo.replace("/", "-")}-${stamp}-${randomBytes(3).toString("hex")}`);
  const git: Git = async (args, cwd = dir, env) => (await host.run("git", args, { cwd, env, timeoutMs: 120_000, maxBuffer: 16 * 1024 * 1024 })).stdout.trim();
  try {
    await git(["fetch", "origin", "main"], checkout);
    await git(["worktree", "add", "--detach", dir, "origin/main"], checkout);
    for (const [path, text] of entries) await host.writeFile(join(dir, path), text);
    return await work(git, dir, stamp);
  } finally {
    await git(["worktree", "remove", "--force", dir], checkout).catch(() => "");
    if (await host.exists(dir)) await host.remove(dir);
    await git(["worktree", "prune"], checkout).catch(() => "");
  }
}

/** Runs doctor against the proposed files and returns its result. Nothing is pushed. */
export const runWorkflowSmoke = ({ repo, files }: { repo: RepoName; files: Record<string, string> }) =>
  inWorktree(repo, files, (_git, dir) => workflowDeps.doctor(dir));

/** Opens a PR holding the files, only once doctor passes. Returns the PR's URL and branch. */
export const runWorkflowPr = ({ repo, files }: { repo: RepoName; files: Record<string, string> }) =>
  inWorktree(repo, files, async (git, dir, stamp) => {
    const { code, output } = await workflowDeps.doctor(dir);
    if (code !== 0) throw new Error(`sstack-doctor failed (exit ${code}):\n${output}`);
    // Only the written paths, so anything doctor leaves in the worktree stays out of the PR.
    await git(["add", "--", ...Object.keys(files)]);
    const changed = (await git(["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
    if (!changed.length) throw new Error("nothing to save: the files match main");
    await git([...IDENTITY, "commit", "--no-verify", "-m", "chore(sstack): update workflow config"]);

    const branch = `${BRANCH_PREFIX}workflow-${repo.replace("/", "-")}-${stamp}`;
    // No --force: the stamp makes the branch unique, so a collision fails instead of overwriting.
    await git([...CREDENTIALS, "push", workflowDeps.remote(repo), `HEAD:refs/heads/${branch}`], dir, {
      [TOKEN_ENV]: await workflowDeps.token(repo),
      GIT_TERMINAL_PROMPT: "0",
    });
    const { url } = await workflowDeps.github.createPull(repo, {
      title: "Update sstack workflow config",
      head: branch,
      base: "main",
      body: `${changed.map((path) => `- \`${path}\``).join("\n")}\n\nsstack-doctor passed.`,
    });
    return { url, branch };
  });

export const mayCreate = (kind: "workflow_pr" | "workflow_smoke", role: Role) => kind === "workflow_smoke" || role === "admin";
