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

function block(css: string, selector: string): Vars {
  const start = css.search(new RegExp(`(^|\\n)${selector.replace(/\./g, "\\.")}\\s*\\{`));
  assert.ok(start >= 0, `no ${selector} block`);
  const body = css.slice(css.indexOf("{", start) + 1, css.indexOf("}", start));
  const vars: Vars = {};
  for (const [, name, value] of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[name!] = value!.trim();
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
  if (rgba && rgba.length >= 3 && rgba.every((n) => !Number.isNaN(n))) return [rgba[0]!, rgba[1]!, rgba[2]!, rgba[3] ?? 1];
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

const TEXT = [
  "foreground",
  "card-foreground",
  "popover-foreground",
  "secondary-foreground",
  "muted-foreground",
  "accent-foreground",
  "ink-2",
  "faint",
  "primary-text",
  "info",
  "success",
  "warning",
  "destructive",
  "violet",
  "destructive-foreground",
  "info-foreground",
  "success-foreground",
  "warning-foreground",
];
const SURFACES = ["background", "surface-1", "surface-2", "card", "popover", "secondary", "muted", "accent"];
const ON: [string, string][] = [
  ["primary-foreground", "primary"],
  ["on-lime", "lime"],
  ["primary-text", "primary-soft"],
  ["success", "success-soft"],
  ["warning", "warning-soft"],
  ["danger", "danger-soft"],
  // components/ui button and badge put text-white on bg-destructive; stats and links use text-primary.
  ["#ffffff", "destructive"],
  ["primary", "background"],
  ["primary", "card"],
];
// Status text sits on bg-<status>/4..16 tints over the page or a card (badge, alert, run notes).
const TINTS = [0.04, 0.08, 0.1, 0.12, 0.16];
type Pair = { text: string; bg: string; alpha?: number; base?: string };
const PAIRS: Pair[] = [
  ...TEXT.flatMap((text) => SURFACES.map((bg) => ({ text, bg }))),
  ...ON.map(([text, bg]) => ({ text, bg })),
  ...["success", "warning", "destructive", "info"].flatMap((status) =>
    [status, `${status}-foreground`].flatMap((text) => ["background", "card"].flatMap((base) => TINTS.map((alpha) => ({ text, bg: status, alpha, base })))),
  ),
];
// Pairs that fail only because of component markup (a literal text-white, text-primary for coloured text);
// the R25 screen plans move them to tokens that pass. Listed so the check still sees them change.
const KNOWN_GAPS = ["dark: #ffffff on --destructive is 2.51:1", "dark: --primary on --background is 3.80:1", "dark: --primary on --card is 3.71:1"];

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
    const paint = (name: string) => color(name.startsWith("#") ? name : resolve(vars, name));
    const label = (name: string) => (name.startsWith("#") ? name : `--${name}`);
    for (const { text, bg, alpha, base } of PAIRS) {
      const [r, g, b, a] = paint(bg);
      const under = base ? over(paint(base), page) : page;
      const surface = over([r, g, b, alpha ?? a], under);
      const contrast = ratio(over(paint(text), surface), surface);
      const where = alpha ? `${label(bg)}/${alpha * 100} over ${label(base!)}` : label(bg);
      if (contrast < AA) failures.push(`${theme}: ${label(text)} on ${where} is ${contrast.toFixed(2)}:1, below ${AA}:1`);
    }
  }
  return failures;
}

// Every pair passes today, apart from the known markup gaps, which fail exactly as listed.
const failures = contrastFailures(globals);
const unknown = failures.filter((f) => !KNOWN_GAPS.some((gap) => f.startsWith(gap)));
assert.deepEqual(unknown, [], `contrast below WCAG AA:\n${unknown.join("\n")}`);
for (const gap of KNOWN_GAPS)
  assert.ok(
    failures.some((f) => f.startsWith(gap)),
    `known gap changed or closed, update KNOWN_GAPS: ${gap}`,
  );

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

// The tokens are hive.css's values. hive.css's --muted is a text colour; here it is --muted-foreground.
const HIVE_TOKENS: Record<string, string> = {
  bg: "bg",
  "surface-1": "surface-1",
  "surface-2": "surface-2",
  card: "card",
  border: "border",
  "border-strong": "border-strong",
  ink: "ink",
  "ink-2": "ink-2",
  muted: "muted-foreground",
  primary: "primary",
  "primary-text": "primary-text",
  "primary-soft": "primary-soft",
  "on-primary": "on-primary",
  lime: "lime",
  "on-lime": "on-lime",
  success: "success",
  "success-soft": "success-soft",
  warning: "warning",
  "warning-soft": "warning-soft",
  danger: "danger",
  "danger-soft": "danger-soft",
  focus: "focus",
};
const hiveLight = block(hive, ".hv");
const hiveThemes: Record<string, Vars> = { light: hiveLight, dark: { ...hiveLight, ...block(hive, ".hv.dark") } };
// hive.css's light status text fails AA on the components' status tints; globals.css darkens it a shade.
const DEVIATIONS: Record<string, Vars> = { light: { danger: "#be2631", success: "#137238", warning: "#965500" }, dark: {} };
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
