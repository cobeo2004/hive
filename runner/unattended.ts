import { isAbsolute, join } from "node:path";
import type { JobHost } from "../lib/host";
import type { PlanGate } from "../lib/plan-gate";
import { patch } from "../lib/toml-patch";

/** sstack's `local` layer: git-ignored and per checkout, so a launch states one job's gate without committing. */
export const LOCAL_CONFIG = ".sstack/local/config.toml";

/**
 * The `[unattended]` table sstack reads. `enabled` and `plan_gate` follow R14 and are not in
 * docs/spec/config.md yet; every other line of the file is left as it was.
 */
export function unattendedConfig(existing: string, gate: PlanGate): string {
  return patch(patch(existing, "unattended", "enabled", true), "unattended", "plan_gate", gate);
}

/** Puts the checkout's own file back, or removes it when this launch made it. */
function restore(host: JobHost, path: string, prev: string | null) {
  return prev === null ? host.remove(path) : host.writeFile(path, prev);
}

/** Puts the local layer in this checkout's `info/exclude` when nothing else ignores it, so the write never dirties the repo. */
async function ensureIgnored(host: JobHost, checkout: string) {
  const ignored = await host.run("git", ["-C", checkout, "check-ignore", "-q", LOCAL_CONFIG], { timeoutMs: 30_000 }).then(
    () => true,
    () => false,
  );
  if (ignored) return;
  const fromGit = (await host.run("git", ["-C", checkout, "rev-parse", "--git-path", "info/exclude"], { timeoutMs: 30_000 })).stdout.trim();
  const exclude = isAbsolute(fromGit) ? fromGit : join(checkout, fromGit);
  const text = (await host.readFile(exclude)) ?? "";
  await host.writeFile(exclude, `${text}${text && !text.endsWith("\n") ? "\n" : ""}.sstack/local/\n`);
}

/**
 * Starts a lead thread with the job's plan gate in the checkout's sstack local layer, written before
 * the agent's first sstack call. The seed goes in the checkout itself because sstack reads a linked
 * worktree's own `.sstack/local/` only when it holds a config file and falls back to the primary
 * checkout's otherwise: the gate is in place the instant T3 makes the worktree, whatever the timing.
 * Once T3 names the worktree, the job gets its own copy and the checkout's file goes back to what it
 * held, so a seed never rides into the next job launched from the same checkout. Entries of one pass
 * start one at a time (launchEntries is sequential), so seeds never interleave.
 *
 * A worktree T3 never names leaves the seed in place: it still holds this job's gate, until the next
 * launch in that checkout seeds its own.
 */
export async function startUnattended(
  host: JobHost,
  checkout: string,
  gate: PlanGate,
  start: () => Promise<string>,
  worktreeOf: (threadId: string) => Promise<string | undefined>,
): Promise<string> {
  const path = join(checkout, LOCAL_CONFIG);
  const prev = await host.readFile(path);
  const text = unattendedConfig(prev ?? "", gate);
  await ensureIgnored(host, checkout);
  await host.writeFile(path, text);
  let threadId: string;
  try {
    threadId = await start();
  } catch (error) {
    await restore(host, path, prev);
    throw error;
  }
  // A worktree the helper cannot name is no reason to fail a thread that is already running.
  const worktree = await worktreeOf(threadId).catch(() => undefined);
  if (!worktree) return threadId;
  await host.writeFile(join(worktree, LOCAL_CONFIG), text);
  await restore(host, path, prev);
  return threadId;
}
