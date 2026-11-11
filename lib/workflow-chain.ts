// sstack's step chain (lib/sstack_workflow.py `_kids` + `order`) over a repo snapshot's files.
// Pure TS, no node/Bun imports, so the canvas can run it in the browser.
import { parse } from "smol-toml";

type Val = string | boolean | number;
export type Spec = {
  name: string;
  after: string;
  on_fail: string;
  gate: boolean;
  enabled: boolean;
  role: string;
  kind: "role" | "command" | "inline";
  builtin: boolean;
};
type Chain = { order: string[]; after: Record<string, string> };

// smol-toml parses; nested tables flatten to dotted keys (`unattended.plan_gate`); readToml throws on invalid TOML.
const flat = (table: object, prefix = ""): [string, Val][] =>
  Object.entries(table).flatMap(([k, v]) =>
    typeof v === "string" || typeof v === "boolean" || typeof v === "number"
      ? [[prefix + k, v]]
      : v && typeof v === "object" && !Array.isArray(v) && !(v instanceof Date)
        ? flat(v, `${prefix}${k}.`)
        : [],
  );
export const readToml = (text: string): Record<string, Val> => Object.fromEntries(flat(parse(text)));
// The files steps() and meta() read. One that does not parse is reported (tomlError) and ignored (usable).
const TOML = /^\.sstack\/(steps\/[^/]+\/step|roles\/[^/]+|config)\.toml$/;
const failure = (path: string, text: string) => {
  try {
    if (TOML.test(path)) readToml(text);
  } catch (e) {
    return e instanceof Error ? e.message : String(e);
  }
  return "";
};
export function tomlError(files: Record<string, string>): string | null {
  const bad = Object.entries(files).find(([path, text]) => failure(path, text));
  return bad ? `${bad[0]}: ${failure(...bad)}` : null;
}
export const usable = (files: Record<string, string>) => Object.fromEntries(Object.entries(files).filter(([path, text]) => !failure(path, text)));

// sstack docs/spec/workflow.md "Built-in steps"
const D = (after: string, gate: boolean, kind: Spec["kind"], role = "", on_fail = "") => ({ after, gate, kind, role, on_fail });
const DEFAULTS = {
  recon: D("", true, "role", "investigate"),
  plan: D("recon", true, "role", "plan"),
  implement: D("plan", false, "role", "implement"),
  gate: D("implement", false, "command", "", "implement"),
  review: D("gate", true, "role", "review", "implement"),
  pr: D("review", true, "inline"),
};

const STEP = /^\.sstack\/steps\/([^/]+)\/step\.toml$/;
const stepPath = (name: string) => `.sstack/steps/${name}/step.toml`;

export function steps(all: Record<string, string>): Record<string, Spec> {
  const files = usable(all);
  const names = new Set([...Object.keys(DEFAULTS), ...Object.keys(files).flatMap((p) => STEP.exec(p)?.[1] ?? [])]);
  const out: Record<string, Spec> = {};
  for (const name of names) {
    const builtin = Object.hasOwn(DEFAULTS, name);
    const t = readToml(files[stepPath(name)] ?? "");
    const str = (key: string, d: string) => (typeof t[key] === "string" ? (t[key] as string) : d);
    const d = builtin ? DEFAULTS[name as keyof typeof DEFAULTS] : D("", false, "command");
    const role = str("role", d.role);
    out[name] = {
      name,
      after: str("after", d.after),
      on_fail: str("on_fail", d.on_fail),
      gate: name === "pr" || (typeof t.gate === "boolean" ? t.gate : d.gate),
      enabled: t.enabled !== false,
      role,
      // the snapshot has no run.sh or brief.md, so a custom step is a role when it names one
      kind: builtin ? d.kind : role ? "role" : "command",
      builtin,
    };
  }
  return out;
}

export function chain(specs: Record<string, Spec>): string[] {
  const kids = new Map<string, string[]>();
  for (const n of Object.keys(specs).filter((n) => specs[n].enabled)) {
    let a = specs[n].after;
    for (const seen = new Set<string>(); a && Object.hasOwn(specs, a) && !specs[a].enabled && !seen.has(a); a = specs[a].after) seen.add(a);
    kids.set(a, [...(kids.get(a) ?? []), n]);
  }
  for (const v of kids.values()) v.sort((x, y) => Number(specs[x].builtin) - Number(specs[y].builtin) || (x < y ? -1 : x > y ? 1 : 0));
  const out: string[] = [];
  const walk = (parent: string) => {
    for (const n of kids.get(parent) ?? []) {
      if (out.includes(n)) continue;
      out.push(n);
      walk(n);
    }
  };
  walk("");
  return out;
}

// Drag `name` onto `onto`: the fewest `after` lines that make sstack resolve the new order.
export function move(specs: Record<string, Spec>, name: string, onto: string): Chain | { error: string } {
  const cur = chain(specs);
  if (name === "recon" || name === "pr") return { error: `${name} stays pinned` };
  if (name === onto || !cur.includes(name) || !cur.includes(onto)) return { error: "nothing to move" };
  const next = cur.filter((n) => n !== name);
  next.splice(cur.indexOf(onto), 0, name);
  if (next[0] !== "recon") return { error: "recon stays first" };
  if (next.at(-1) !== "pr") return { error: "pr stays last" };
  // ponytail: O(n²) simulation, fine for single-digit step counts.
  const fits = (after: Record<string, string>) =>
    chain(Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { ...s, after: after[k] ?? s.after }]))).join() === next.join();
  let after: Record<string, string> = {};
  next.forEach((n, i) => i && specs[n].after !== next[i - 1] && (after[n] = next[i - 1]));
  if (!fits(after)) return { error: "that order can't be written as after keys" };
  for (const k of next.filter((n) => Object.hasOwn(after, n))) {
    const rest = Object.fromEntries(Object.entries(after).filter(([n]) => n !== k));
    if (fits(rest)) after = rest;
  }
  return { order: next, after };
}

// The exact lines Save writes; the canvas shows them as `- from` / `+ to`.
export function diffLines(specs: Record<string, Spec>, after: Record<string, string>) {
  return Object.entries(after)
    .filter(([n, to]) => specs[n].after !== to)
    .map(([n, to]) => ({ path: stepPath(n), from: `after = "${specs[n].after}"`, to: `after = "${to}"` }));
}

// sstack defaults/roles/*.toml; a repo role file overrides these per key (review declares none)
const ROLES: Record<string, Record<string, string>> = {
  investigate: { harness: "claude", model: "sonnet" },
  plan: { harness: "claude", model: "opus" },
  scout: { harness: "claude", model: "haiku" },
  implement: { harness: "pi", model: "opencode-go/deepseek-v4.1-flash" },
};

export function meta(all: Record<string, string>, spec: Spec): { model: string; planGate?: "Inbox" | "Auto" } {
  const files = usable(all);
  const r = { ...(Object.hasOwn(ROLES, spec.role) ? ROLES[spec.role] : {}), ...readToml(files[`.sstack/roles/${spec.role}.toml`] ?? "") };
  const model = spec.kind !== "role" ? "—" : r.harness && r.model ? `${r.harness} · ${r.model}` : "default";
  if (spec.name !== "plan") return { model };
  return { model, planGate: readToml(files[".sstack/config.toml"] ?? "")["unattended.plan_gate"] === "inbox" ? "Inbox" : "Auto" };
}
