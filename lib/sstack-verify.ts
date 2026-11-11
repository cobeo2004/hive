import { parse } from "smol-toml";
import type { EvidenceCheckName, PlannedCheck } from "./evidence";

// An sstack repo's checks: the `verify` list in .sstack/project.toml. factory-verify runs them
// first (R17), and the list recorded on the repo's row is what its evidence is held to.

export const SSTACK_PROJECT_PATH = ".sstack/project.toml";

const strings = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === "string") ? value.map((v) => v.trim()).filter(Boolean) : null);

/** The `verify` list of a project.toml text; null when it has none, isn't strings or isn't TOML. */
export function readVerify(text: string): string[] | null {
  try {
    return strings((parse(text) as { verify?: unknown }).verify);
  } catch {
    return null;
  }
}

const NAMES: [RegExp, EvidenceCheckName][] = [
  [/\btypecheck\b|\btsc\b/, "typecheck"],
  [/\blint\b|\beslint\b/, "lint"],
  [/\btest\b/, "test"],
  [/\bbuild\b/, "build"],
];

/** The verify commands as checks, each named after what it looks like it runs, else custom. */
export const verifyChecks = (commands: readonly string[]): PlannedCheck[] =>
  commands.map((command) => ({ name: NAMES.find(([re]) => re.test(command))?.[1] ?? "custom", command }));
