import type { PlannedCheck } from "./evidence";
import { matchesAny } from "./globs";
import { CHECKS, RECIPE_PATH } from "./recipe";

// What a PR must not change if its own checks are to count as proof. The recorded recipe's commands
// are trusted (lib/evidence.ts `headEvidence` compares them), but a command is only as honest as the
// files it runs: the recipe itself, the package.json scripts it calls and the CI workflows. A PR
// that edits any of them hands over, whatever its evidence says.

const WORKFLOWS = [".github/workflows/**"];
const PACKAGE_JSON = "package.json";

export type Scripts = Readonly<Record<string, string>>;

/** The string-valued `scripts` of a package.json text; null when it is missing or not JSON. */
export function scriptsOf(packageJson: string | null): Scripts | null {
  if (packageJson === null) return null;
  try {
    const scripts = (JSON.parse(packageJson) as { scripts?: Record<string, unknown> } | null)?.scripts ?? {};
    return Object.fromEntries(Object.entries(scripts).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
  } catch {
    return null;
  }
}

/**
 * A command as POSIX-style argv tokens: adjacent quoted and bare pieces join (`format:""check` is
 * `format:check`), and unquoted whitespace, `&`, `;` and `|` end a token. null when it can't be read
 * statically: a backslash, backtick, `$`, newline, glob character, unquoted `()<>` or an open quote.
 */
export function tokenize(command: string): string[] | null {
  if (/[\\`$\n\r*?]/.test(command)) return null;
  const tokens: string[] = [];
  let token = "";
  const end = () => {
    if (token) tokens.push(token);
    token = "";
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (c === "'" || c === '"') {
      const close = command.indexOf(c, i + 1);
      if (close === -1) return null;
      token += command.slice(i + 1, close);
      i = close;
    } else if (/[\s&;|]/.test(c)) end();
    else if (/[()<>]/.test(c)) return null;
    else token += c;
  }
  end();
  return tokens;
}

// ponytail: any token that names a script counts as running it. It over-matches (`echo test`), which
// only hands over more; parsing each package manager's flags is what let `bun run --silent x` slip by.
/**
 * The scripts the commands may run in any of these versions, following one script calling another
 * (head-only scripts count, so adding one is as visible as changing one), and the unreadable commands.
 */
export function usedScripts(commands: readonly string[], ...versions: readonly Scripts[]): { used: string[]; unreadable: string[] } {
  const used = new Set<string>();
  const unreadable: string[] = [];
  const queue = [...commands];
  for (let command = queue.pop(); command !== undefined; command = queue.pop()) {
    const parsed = tokenize(command);
    if (!parsed) {
      unreadable.push(command);
      continue;
    }
    for (const name of parsed) {
      if (used.has(name)) continue;
      const bodies = versions.flatMap((scripts) => (Object.hasOwn(scripts, name) ? [scripts[name]!] : []));
      if (bodies.length === 0) continue;
      used.add(name);
      queue.push(...bodies);
    }
  }
  return { used: [...used].sort(), unreadable };
}

/**
 * Why this PR edits what the factory trusts, one reason each; empty when it doesn't. `required` is
 * the recorded recipe's checks, null for a repo whose checks are its package.json scripts. `base`
 * and `head` are the two versions of package.json's scripts; null when one couldn't be read.
 * `verify` is the recorded project.toml verify list, whose scripts are trusted too.
 */
export function trustedEdits({
  files,
  required,
  verify = null,
  base,
  head,
}: {
  files: readonly string[];
  required: readonly PlannedCheck[] | null;
  verify?: readonly string[] | null;
  base: Scripts | null;
  head: Scripts | null;
}): string[] {
  const reasons: string[] = [];
  if (files.includes(RECIPE_PATH)) reasons.push(`The pull request edits the recipe the factory trusts: ${RECIPE_PATH}.`);
  const workflows = files.filter((file) => matchesAny(file, WORKFLOWS));
  if (workflows.length > 0)
    reasons.push(
      `The pull request edits CI workflows (${workflows.slice(0, 3).join(", ")}${workflows.length > 3 ? ` and ${workflows.length - 3} more` : ""}).`,
    );
  if (files.includes(PACKAGE_JSON)) {
    if (!base || !head) reasons.push("The pull request edits package.json, and its scripts couldn't be compared with the base branch's.");
    else {
      const commands = [...(required ? required.map((c) => c.command) : CHECKS.map((name) => `bun run ${name}`)), ...(verify ?? [])];
      const { used, unreadable } = usedScripts(commands, base, head);
      const changed = used.filter((name) => base[name] !== head[name]);
      if (changed.length > 0)
        reasons.push(`The pull request edits the check scripts the factory trusts: ${changed.map((name) => `package.json scripts.${name}`).join(", ")}.`);
      const list = unreadable.slice(0, 3).map((c) => `\`${c}\``);
      if (list.length > 0)
        reasons.push(`The pull request edits package.json, and the check command ${list.join(", ")} can't be read to tell which scripts it runs.`);
    }
  }
  return reasons;
}
