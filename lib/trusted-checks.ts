import { matchesAny } from "./globs";
import { RECIPE_PATH } from "./recipe";

// What a PR must not change if its own checks are to count as proof. The recorded recipe's commands
// are trusted (lib/evidence.ts `headEvidence` compares them), but a command is only as honest as the
// files it runs: the recipe, the CI workflows and the package.json scripts. Which scripts a command
// runs can't be told reliably (flags, quoting, aliases, lifecycle scripts), so any change to the
// scripts hands over, whatever the commands are.

const WORKFLOWS = [".github/workflows/**"];
const PACKAGE_JSON = "package.json";
const ROOT_CONFIG = [".npmrc", "bunfig.toml"];

export type Scripts = Readonly<Record<string, string>>;

/** The `scripts` of a package.json text; null when it isn't JSON, is ambiguous or holds anything but string scripts. */
export function scriptsOf(packageJson: string | null): Scripts | null {
  if (packageJson === null) return null;
  // JSON.parse keeps the last duplicate key but bun runs the first, so a second `scripts` block (or a
  // `\u`-escaped spelling of one) could hide the scripts that really run. Over-matching only hands over.
  if ((packageJson.match(/"scripts"/g) ?? []).length > 1 || /\\u/.test(packageJson)) return null;
  try {
    const scripts: unknown = (JSON.parse(packageJson) as { scripts?: unknown } | null)?.scripts ?? {};
    // A non-string value (`"t": null` after `"t": "echo A"`) means a duplicate key JSON.parse and bun read differently.
    if (typeof scripts !== "object" || scripts === null || Array.isArray(scripts)) return null;
    if (!Object.values(scripts).every((value) => typeof value === "string")) return null;
    // bun skips an empty script value and keeps the first string when the last is a non-string, while JSON.parse keeps the
    // last, so a repeated key is only safe when both agree, which varies by value: reject every one. The text is valid JSON
    // here, so its string tokens are in sync; a token followed by `:` is a key, and decoding it folds `\u`/`\/` spellings.
    // Over-matching (a script name that is also a dependency name, a nested key) only hands over.
    const watched = new Set(["scripts", ...Object.keys(scripts)]);
    const seen = new Set<string>();
    const colon = /\s*:/y;
    for (const token of packageJson.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
      colon.lastIndex = token.index + token[0].length;
      if (!colon.test(packageJson)) continue;
      const key = JSON.parse(token[0]) as string;
      if (!watched.has(key)) continue;
      if (seen.has(key)) return null;
      seen.add(key);
    }
    return scripts as Scripts;
  } catch {
    return null;
  }
}

/**
 * Why this PR edits what the factory trusts, one reason each; empty when it doesn't. `base` and `head`
 * are the two versions of package.json's scripts; null when one couldn't be read.
 */
export function trustedEdits({ files, base, head }: { files: readonly string[]; base: Scripts | null; head: Scripts | null }): string[] {
  const reasons: string[] = [];
  if (files.includes(RECIPE_PATH)) reasons.push(`The pull request edits the recipe the factory trusts: ${RECIPE_PATH}.`);
  const workflows = files.filter((file) => matchesAny(file, WORKFLOWS));
  if (workflows.length > 0)
    reasons.push(
      `The pull request edits CI workflows (${workflows.slice(0, 3).join(", ")}${workflows.length > 3 ? ` and ${workflows.length - 3} more` : ""}).`,
    );
  for (const file of ROOT_CONFIG) if (files.includes(file)) reasons.push(`The pull request edits ${file}, which changes how the factory's check scripts run.`);
  for (const file of files)
    if (file !== PACKAGE_JSON && file.split("/").pop() === PACKAGE_JSON)
      reasons.push(`The pull request edits a nested package.json (${file}), whose scripts the factory can't compare.`);
  if (files.includes(PACKAGE_JSON)) {
    if (!base || !head) reasons.push("The pull request edits package.json, and its scripts couldn't be compared with the base branch's.");
    else {
      const changed = [...new Set([...Object.keys(base), ...Object.keys(head)])].filter((name) => base[name] !== head[name]).sort();
      if (changed.length > 0)
        reasons.push(
          `The pull request edits the package.json scripts the factory's checks run through: ${changed
            .slice(0, 5)
            .map((name) => `package.json scripts.${name}`)
            .join(", ")}${changed.length > 5 ? ` and ${changed.length - 5} more` : ""}.`,
        );
    }
  }
  return reasons;
}
