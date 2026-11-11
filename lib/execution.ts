import { z } from "zod";

/** Where a runner starts new factory threads: in its own T3, or in a Modal sandbox per job. */
export const EXECUTIONS = ["local", "modal"] as const;
export const executionSchema = z.enum(EXECUTIONS);
export type Execution = z.infer<typeof executionSchema>;

export const DEFAULT_EXECUTION: Execution = "local";

/** A repo runs mobile tests when its snapshot's .sstack/project.toml has a `[test.mobile]` table line (R22.4; no TOML parser). */
export const isMobileSnapshot = (files: Record<string, string> | null | undefined) =>
  /^[ \t]*\[test\.mobile\][ \t]*(#.*)?$/m.test(files?.[".sstack/project.toml"] ?? "");

/**
 * Where a claimed job's sandbox is: running while sandbox_id is set, hibernated while only its
 * snapshot is left, null for a job that never ran in one or gave it back.
 */
export type SandboxState = "running" | "hibernated";

export function sandboxState(job: { sandbox_id: string | null; sandbox_snapshot: string | null }): SandboxState | null {
  if (job.sandbox_id) return "running";
  return job.sandbox_snapshot ? "hibernated" : null;
}
