// The step panel's edit model: pending edits, the lines they show, the files they write. `patch` (lib/toml-patch) is passed in: it can't load in the browser.
import { parse } from "smol-toml";
import { ROLES, readToml, usable, type Spec } from "./workflow-chain";

export type Edit = { path: string; section: string; key: string; value: string | number | boolean };
type Patch = (text: string, section: string, key: string, value: Edit["value"]) => string;

export const CONFIG = ".sstack/config.toml";
export const stepFile = (name: string) => `.sstack/steps/${name}/step.toml`;
export const roleFile = (role: string) => `.sstack/roles/${role}.toml`;

// sstack docs/spec/workflow.md "Built-in steps" (gate and pr are 0, the fallback): max_agents per step, min_score only on review
const NUMS: Record<string, { max_agents: number; min_score?: number }> = {
  recon: { max_agents: 3 },
  plan: { max_agents: 2 },
  implement: { max_agents: 1 },
  review: { max_agents: 2, min_score: 5 },
};

const num = (v: unknown) => (typeof v === "number" ? v : undefined);
export function stepValues(files: Record<string, string>, spec: Spec): { max_agents: number; min_score?: number } {
  const d = Object.hasOwn(NUMS, spec.name) ? NUMS[spec.name] : { max_agents: 0 }; // ponytail: a custom step defaults to 0 agents, unchecked against sstack
  const t = readToml(usable(files)[stepFile(spec.name)] ?? "");
  const min_score = num(t.min_score) ?? d.min_score;
  return { max_agents: num(t.max_agents) ?? d.max_agents, ...(min_score === undefined ? {} : { min_score }) };
}

type Member = Record<string, unknown>;
export function roleValues(files: Record<string, string>, role: string) {
  const text = usable(files)[roleFile(role)] ?? "";
  const r: Record<string, string | number | boolean> = { ...(Object.hasOwn(ROLES, role) ? ROLES[role] : {}), ...readToml(text) };
  const str = (k: string) => (typeof r[k] === "string" ? (r[k] as string) : "");
  const panel = (parse(text) as { panel?: unknown }).panel; // readToml skips arrays
  const hints: Record<string, { harness: string; model: string }> = {};
  for (const [k, v] of Object.entries(r)) {
    const m = /^hint\.([\w-]+)\.(harness|model)$/.exec(k); // a flattened key, not TOML text
    if (m && typeof v === "string") (hints[m[1]] ??= { harness: "", model: "" })[m[2] as "harness" | "model"] = v;
  }
  return {
    harness: str("harness"),
    model: str("model"),
    effort: str("effort"),
    mode: str("mode"),
    panel: Array.isArray(panel) ? (panel as Member[]) : [],
    hints,
  };
}

/** The plan_gate the config file sets itself, if any: what a plan gate edit is measured against, not the displayed default. */
export const fileGate = (files: Record<string, string>) => {
  const g = readToml(usable(files)[CONFIG] ?? "")["unattended.plan_gate"];
  return typeof g === "string" ? g : undefined;
};

const same = (a: Edit, b: Edit) => a.path === b.path && a.section === b.section && a.key === b.key;
/** Sets `edit`, replacing the pending edit of the same key; an edit back to `original` (the file's own value, undefined if unset) is dropped. */
export const upsert = (edits: Edit[], edit: Edit, original: Edit["value"] | undefined): Edit[] => [
  ...edits.filter((e) => !same(e, edit)),
  ...(edit.value === original ? [] : [edit]),
];

const render = (v: Edit["value"]) => (typeof v === "string" ? JSON.stringify(v) : String(v)); // as patch writes it
const short = (path: string) => path.replace(/^\.sstack\//, "");
// one line per field edit and per file edited as text (`raw` wins over field edits on its path)
export const changeLines = (edits: Edit[], raw: Record<string, string>): string[] => [
  ...edits.filter((e) => !Object.hasOwn(raw, e.path)).map((e) => `${short(e.path)}: ${e.section ? `[${e.section}] ` : ""}${e.key} = ${render(e.value)}`),
  ...Object.keys(raw).map((p) => `${short(p)}: edited as text`),
];

// the `workflow_pr` files payload: every touched path with its new text
export function applyEdits(files: Record<string, string>, edits: Edit[], raw: Record<string, string>, patch: Patch): Record<string, string> {
  const out: Record<string, string> = { ...raw };
  for (const e of edits) if (!Object.hasOwn(raw, e.path)) out[e.path] = patch(out[e.path] ?? files[e.path] ?? "", e.section, e.key, e.value);
  return out;
}
