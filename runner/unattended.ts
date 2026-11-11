import { isAbsolute, join } from "node:path";
import type { JobHost } from "../lib/host";
import type { PlanGate } from "../lib/plan-gate";
import { patch } from "../lib/toml-patch";

/** sstack's `local` layer: git-ignored and per checkout, so a launch states one job's gate without committing. */
export const LOCAL_CONFIG = ".sstack/local/config.toml";

/** Where a failure after `start` returned goes: the thread is live, so it never reaches the caller. */
export type GateLog = (message: string, detail: Record<string, unknown>) => void;

/**
 * The `[unattended]` table sstack reads. `enabled` and `plan_gate` follow R14 and are not in
 * docs/spec/config.md yet; every other line of the file is left as it was.
 */
export function unattendedConfig(existing: string, gate: PlanGate): string {
  return patch(patch(existing, "unattended", "enabled", true), "unattended", "plan_gate", gate);
}

/**
 * A seed opens with this comment and base64 of `{prev}`, the file it replaced: a seed whose launch never
 * got a worktree reads back as that original, never as itself, so the next launch restores the user's.
 */
const MARK = "# hive:launch-seed prev=";

function prevOf(text: string | null): string | null {
  if (!text?.startsWith(MARK)) return text;
  return (JSON.parse(Buffer.from(text.slice(MARK.length).split("\n")[0]!, "base64").toString("utf8")) as { prev: string | null }).prev;
}

const first = (error: unknown) => (error instanceof Error ? error.message.split("\n")[0]! : "unknown error");

/** Puts the checkout's own file back, or removes it when this launch made it. */
const restore = (host: JobHost, path: string, prev: string | null) => (prev === null ? host.remove(path) : host.writeFile(path, prev));

/**
 * Puts the local layer in this checkout's `info/exclude` when nothing else ignores it, so the write never
 * dirties the repo. `git check-ignore -q` exits 1 for "not ignored", its only "no": anything else (no git,
 * a timeout) rethrows, since appending would only duplicate the line.
 */
async function ensureIgnored(host: JobHost, checkout: string) {
  try {
    await host.run("git", ["-C", checkout, "check-ignore", "-q", LOCAL_CONFIG], { timeoutMs: 30_000 });
    return;
  } catch (error) {
    if ((error as { code?: number }).code !== 1) throw error;
  }
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
 * Once T3 names the worktree the job gets its own copy and the checkout's file goes back to what it held,
 * so a seed never rides into the next job launched from the same checkout (launchEntries starts one at a
 * time, so seeds never interleave). After `start` returns an id nothing may reach the caller as an error:
 * the id comes back and failures go to `onError`. A start whose thread may exist keeps its seed for the
 * agent that may be running on it; only a clear failure restores.
 */
export async function startUnattended(
  host: JobHost,
  checkout: string,
  gate: PlanGate,
  start: () => Promise<string>,
  worktreeOf: (threadId: string) => Promise<string | undefined>,
  mayHaveStarted: (error: unknown) => boolean,
  onError?: GateLog,
): Promise<string> {
  const path = join(checkout, LOCAL_CONFIG);
  const prev = prevOf(await host.readFile(path));
  const text = unattendedConfig(prev ?? "", gate);
  await ensureIgnored(host, checkout);
  await host.writeFile(path, `${MARK}${Buffer.from(JSON.stringify({ prev })).toString("base64")}\n${text}`);
  let threadId: string;
  try {
    threadId = await start();
  } catch (error) {
    if (mayHaveStarted(error)) throw error;
    await restore(host, path, prev).catch((failed: unknown) => onError?.("launch:gate-restore", { error: first(failed) }));
    throw error;
  }
  try {
    const worktree = await worktreeOf(threadId);
    if (!worktree) return threadId;
    await host.writeFile(join(worktree, LOCAL_CONFIG), text);
    await restore(host, path, prev);
  } catch (error) {
    onError?.("launch:gate-file", { threadId, error: first(error) });
  }
  return threadId;
}
