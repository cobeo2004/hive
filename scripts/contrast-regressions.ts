import "./test-guard";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// R25a: app/globals.css wears design/screens/hive.css's tokens, and every text/background pair it
// defines reads at WCAG AA (4.5:1) in both themes.
const root = join(import.meta.dirname, "..");
const globals = readFileSync(join(root, "app/globals.css"), "utf8");
const hive = readFileSync(join(root, "design/screens/hive.css"), "utf8");
const AA = 4.5;

type Vars = Record<string, string>;
type Rgba = [number, number, number, number];

// Declarations of every top-level block whose selector is exactly `selector`; later blocks win.
function block(css: string, selector: string): Vars {
  const vars: Vars = {};
  let found = false;
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  let depth = 0;
  let start = 0; // where the current depth-0 selector text begins
  let bodyAt = 0;
  for (let i = 0; i < clean.length; i++) {
    const c = clean[i];
    if (c === "{" && depth++ === 0) bodyAt = i + 1;
    else if (c === ";" && depth === 0) start = i + 1;
    else if (c === "}" && depth > 0 && --depth === 0) {
      const sel = clean.slice(start, bodyAt - 1).trim();
      start = i + 1;
      if (sel !== selector) continue;
      found = true;
      for (const [, name, value] of clean.slice(bodyAt, i).matchAll(/--([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) {
        if (/!important/i.test(value!)) throw new Error(`--${name} uses !important, which this check does not model`);
        vars[name!] = value!;
      }
    }
  }
  assert.ok(found, `no ${selector} block`);
  return vars;
}

function resolve(vars: Vars, name: string, seen: string[] = []): string {
  const value = vars[name];
  if (value === undefined) throw new Error(`--${name} is not defined`);
  if (seen.includes(name)) throw new Error(`--${name} refers to itself`);
  return value.replace(/var\(--([\w-]+)\)/g, (_, ref: string) => resolve(vars, ref, [...seen, name]));
}

function color(value: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((c) => c + c).join("") : hex;
    return [0, 2, 4].map((i) => Number.parseInt(full.slice(i, i + 2), 16)).concat(1) as Rgba;
  }
  const rgba = /^rgba?\(([^)]+)\)$/.exec(value)?.[1]?.split(",").map(Number);
  if (rgba && rgba.length >= 3 && rgba.every((n) => !Number.isNaN(n))) {
    const clamp = (n: number, max: number) => Math.min(max, Math.max(0, n));
    return [clamp(rgba[0]!, 255), clamp(rgba[1]!, 255), clamp(rgba[2]!, 255), clamp(rgba[3] ?? 1, 1)];
  }
  throw new Error(`cannot read colour ${value}`);
}

const over = ([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba => [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
const luminance = ([r, g, b]: Rgba) =>
  [r, g, b]
    .map((c) => (c / 255 <= 0.04045 ? c / 255 / 12.92 : ((c / 255 + 0.055) / 1.055) ** 2.4))
    .reduce((sum, c, i) => sum + c * [0.2126, 0.7152, 0.0722][i]!, 0);
const ratio = (a: Rgba, b: Rgba) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
};

const TEXT = (
  "foreground card-foreground popover-foreground secondary-foreground muted-foreground accent-foreground ink-2 faint primary-text " +
  "info success warning destructive violet destructive-foreground info-foreground success-foreground warning-foreground"
).split(" ");
const SURFACES = ["background", "surface-1", "surface-2", "card", "popover", "secondary", "muted", "accent"];
const ON: [string, string][] = [
  ["primary-foreground", "primary"],
  ["on-lime", "lime"],
  ["primary-text", "primary-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
];
// The check covers the token pairs globals.css defines; component-level pairs (opacity modifiers,
// literal colours) are checked by the R25 screen plans.
const PAIRS = [...TEXT.flatMap((text) => SURFACES.map((bg) => ({ text, bg }))), ...ON.map(([text, bg]) => ({ text, bg }))];

function themes(css: string): [string, Vars][] {
  const light = block(css, ":root");
  return [
    ["light", light],
    ["dark", { ...light, ...block(css, ".dark") }],
  ];
}

export function contrastFailures(css: string) {
  const failures: string[] = [];
  for (const [theme, vars] of themes(css)) {
    const page = color(resolve(vars, "bg"));
    assert.equal(page[3], 1, `${theme} --bg must be opaque`);
    const paint = (name: string) => color(resolve(vars, name));
    for (const { text, bg } of PAIRS) {
      const surface = over(paint(bg), page);
      const contrast = ratio(over(paint(text), surface), surface);
      if (contrast < AA) failures.push(`${theme}: --${text} on --${bg} is ${contrast.toFixed(2)}:1, below ${AA}:1`);
    }
  }
  return failures;
}

// Tailwind reads colours through `@theme inline { --color-x: var(--x); }`; a literal there would bypass the check.
export function themeMappingFailures(css: string) {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, "");
  // every `@theme <options> {` block, merged in order (later wins)
  const colors = new Map<string, string>();
  let found = false;
  for (let from = 0; ; ) {
    const open = /@theme\b[^{};]*\{/g;
    open.lastIndex = from;
    const m = open.exec(clean);
    if (!m) break;
    found = true;
    let depth = 1;
    let body = "";
    let i = open.lastIndex;
    for (; i < clean.length; i++) {
      const c = clean[i];
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) break;
      // top-level text only: nested blocks (@keyframes) are skipped
      else if (c !== "}" && depth === 1) body += c;
    }
    from = i + 1;
    for (const [, name, value] of body.matchAll(/--color-([\w-]+)\s*:\s*([^;]+?)\s*(?:;|$)/g)) colors.set(name!, value!);
  }
  assert.ok(found, "no @theme block");
  const checked = new Set([...TEXT, ...SURFACES, ...ON.flat()]);
  const failures: string[] = [];
  for (const [name, value] of colors) {
    if (checked.has(name) && value !== `var(--${name})`) failures.push(`--color-${name} is ${value}, expected var(--${name})`);
  }
  return failures;
}

const failures = [...contrastFailures(globals), ...themeMappingFailures(globals)];
assert.deepEqual(failures, [], `contrast below WCAG AA:\n${failures.join("\n")}`);

// The check bites: a washed-out muted text, or a muted surface it can no longer be read on, fails by name.
const lightOnly = (from: string, to: string) => {
  const at = globals.indexOf(from);
  assert.ok(at >= 0 && at < globals.indexOf(".dark {"), `${from} is not in the light theme`);
  return globals.replace(from, to);
};
assert.ok(
  contrastFailures(lightOnly("--muted-foreground: #6b6b74;", "--muted-foreground: #bbbbbb;")).some((f) =>
    f.startsWith("light: --muted-foreground on --background is 1."),
  ),
  "a #bbbbbb muted text fails",
);
assert.ok(
  contrastFailures(lightOnly("--muted: var(--surface-2);", "--muted: #bbbbbb;")).some((f) => f.startsWith("light: --muted-foreground on --muted is 2.")),
  "a #bbbbbb muted surface fails",
);
assert.ok(
  contrastFailures(`${globals}\n:root { --muted-foreground: #bbbbbb; }\n`).some((f) => f.startsWith("light: --muted-foreground on --background is 1.")),
  "an appended :root block is seen",
);
assert.ok(
  contrastFailures(`${globals}\n:root { --muted-foreground: #bbbbbb }\n`).some((f) => f.startsWith("light: --muted-foreground on --background is 1.")),
  "a last declaration without a semicolon is seen",
);
assert.ok(
  contrastFailures(`${globals}\n:root { --secondary-foreground: #bbbbbb; }\n@media print { .unused {} :root { --secondary-foreground: var(--ink); } }\n`).some(
    (f) => f.startsWith("light: --secondary-foreground "),
  ),
  "a :root nested in an at-rule is ignored",
);
assert.throws(() => contrastFailures(`${globals}\n:root { --secondary-foreground: #bbbbbb !important; }\n`), /!important/);
const mapping = "--color-muted-foreground: var(--muted-foreground);";
assert.ok(globals.includes(mapping), "globals.css maps --color-muted-foreground");
assert.ok(
  themeMappingFailures(globals.replace(mapping, "--color-muted-foreground: #bbbbbb;")).some((f) => f.startsWith("--color-muted-foreground ")),
  "a literal Tailwind colour mapping fails",
);
assert.ok(
  themeMappingFailures(`${globals}\n@theme inline { --color-muted-foreground: #bbbbbb; }\n`).some((f) => f.startsWith("--color-muted-foreground ")),
  "a later @theme block is seen",
);
const themeEnd = globals.indexOf("\n}\n", globals.indexOf("@theme inline {"));
assert.ok(themeEnd >= 0, "found the end of @theme inline");
assert.ok(
  themeMappingFailures(`${globals.slice(0, themeEnd)}\n  --color-warning: #bbbbbb${globals.slice(themeEnd)}`).some((f) => f.startsWith("--color-warning ")),
  "a last @theme declaration without a semicolon is seen",
);
const faint = "--faint: var(--muted-foreground);";
assert.ok(globals.includes(faint), "globals.css defines --faint");
assert.ok(
  contrastFailures(globals.replace(faint, "--faint: rgba(107,107,116,2);")).some((f) => f.startsWith("dark: --faint ")),
  "an out-of-range rgba alpha is clamped",
);

// The tokens are hive.css's values. hive.css's --muted is a text colour; here it is --muted-foreground.
const HIVE_TOKENS: Record<string, string> = Object.fromEntries(
  "bg surface-1 surface-2 card border border-strong ink ink-2 muted primary primary-text primary-soft on-primary lime on-lime success success-soft warning warning-soft danger danger-soft focus"
    .split(" ")
    .map((t) => [t, t === "muted" ? "muted-foreground" : t]),
);
const hiveLight = block(hive, ".hv");
const hiveThemes: Record<string, Vars> = { light: hiveLight, dark: { ...hiveLight, ...block(hive, ".hv.dark") } };
// hive.css's light --success on --success-soft is 4.49:1, below AA; globals.css lightens the surface to #e8f7ed (4.53:1).
const DEVIATIONS: Record<string, Vars> = { light: { "success-soft": "#e8f7ed" }, dark: {} };
for (const [theme, vars] of themes(globals)) {
  for (const [token, ours] of Object.entries(HIVE_TOKENS)) {
    const want = DEVIATIONS[theme]![token] ?? hiveThemes[theme]![token]!;
    assert.deepEqual(color(resolve(vars, ours)), color(want), `${theme}: --${ours} should equal hive.css --${token}`);
  }
}
assert.equal(block(globals, ":root").radius, hiveLight["radius-md"], "--radius is hive.css --radius-md");
const flat = (s: string) => s.replace(/\s+/g, "");
for (const font of ["sans", "mono"]) {
  const ours = flat(/--font-[\w-]+\),\s*([^;]+);/.exec(globals.slice(globals.indexOf(`--font-${font}:`)))?.[1] ?? "");
  assert.equal(ours, flat(hiveLight[`font-${font}`]!), `--font-${font} falls back to hive.css's stack`);
}

console.log("contrast regressions passed");
