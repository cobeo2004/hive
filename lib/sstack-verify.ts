import type { EvidenceCheckName, PlannedCheck } from "./evidence";

// An sstack repo's checks: the `verify` list in .sstack/project.toml. factory-verify runs them
// first (R17), and the list recorded on the repo's row is what its evidence is held to.

export const SSTACK_PROJECT_PATH = ".sstack/project.toml";

const strings = (value: unknown) => (Array.isArray(value) && value.every((v) => typeof v === "string") ? value.map((v) => v.trim()).filter(Boolean) : null);

/** The top-level `verify` string array of a TOML text, read without a TOML library for the panel's Node runtime. */
export function scanVerify(text: string): string[] | null {
  // A multi-line string can hide a fake `verify =`: blank each one out, left to right; unterminated fails safe.
  const blanked = text.replace(/"""[\s\S]*?"""|'''[\s\S]*?'''/g, '""');
  if (blanked.includes('"""') || blanked.includes("'''")) return null;
  const top = blanked.split(/^\s*\[/m)[0] ?? "";
  const start = /^verify\s*=\s*\[/m.exec(top);
  if (!start) return null;
  const items: string[] = [];
  for (let i = start.index + start[0].length; i < top.length; i++) {
    const c = top[i]!;
    if (c === "]") return items.map((v) => v.trim()).filter(Boolean);
    if (c === "#") i = top.indexOf("\n", i) === -1 ? top.length : top.indexOf("\n", i);
    else if (c === "'") {
      const end = top.indexOf("'", i + 1);
      if (end === -1) return null;
      items.push(top.slice(i + 1, end));
      i = end;
    } else if (c === '"') {
      const from = i;
      for (i++; i < top.length && top[i] !== '"'; i++) if (top[i] === "\\") i++;
      try {
        items.push(JSON.parse(top.slice(from, i + 1)) as string);
      } catch {
        return null; // an escape JSON doesn't know (TOML's \e, \U…): fail safe
      }
    } else if (!/[\s,]/.test(c)) return null;
  }
  return null;
}

/** The `verify` list of a project.toml text; null when it has none or isn't TOML. */
export function readVerify(text: string): string[] | null {
  const bun = (globalThis as { Bun?: { TOML: { parse: (text: string) => unknown } } }).Bun;
  if (!bun) return scanVerify(text);
  try {
    return strings((bun.TOML.parse(text) as { verify?: unknown } | null)?.verify);
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
