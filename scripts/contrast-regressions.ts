import "./test-guard";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// ponytail: @tailwindcss/node and lightningcss are hoisted transitive installs (from @tailwindcss/postcss); package.json is held by the ticket, declare them when it opens up.
import { compile } from "@tailwindcss/node";
import { type Rule, type Selector, type TokenOrValue, transform } from "lightningcss";

// R25a: app/globals.css wears design/screens/hive.css's tokens, and every text/background pair it defines reads at WCAG AA
// (4.5:1) in both themes. Nothing parses CSS by hand: globals.css is compiled by Tailwind and read through lightningcss's AST.
const root = join(import.meta.dirname, "..");
const globals = readFileSync(join(root, "app/globals.css"), "utf8");
const hive = readFileSync(join(root, "design/screens/hive.css"), "utf8");
const AA = 4.5;

type Vars = Map<string, TokenOrValue[]>;
type Rgba = [number, number, number, number];
const ast = (css: string) => {
  let rules: Rule[] = [];
  transform({ filename: "x.css", code: Buffer.from(css), visitor: { StyleSheet: (sheet) => void (rules = sheet.rules) } });
  return rules;
};
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
// lightningcss types a style rule's body as optional; it is always there
const body = (rule: Extract<Rule, { type: "style" }>) => ({
  normal: rule.value.declarations?.declarations ?? [],
  important: rule.value.declarations?.importantDeclarations ?? [],
  nested: rule.value.rules ?? [],
});
const layerName = (rule: Rule) => (rule.type === "layer-block" ? rule.value.name?.join(".") : undefined);
const ROOT: Selector = [{ type: "pseudo-class", kind: "root" }];
const cls = (...names: string[]): Selector => names.map((name) => ({ type: "class", name }));
const DARK = cls("dark");
// The custom properties a stylesheet declares for the `light` scope and, over it, the `dark` scope: Tailwind's theme
// layer, then the top-level scope rules. `:root` and `.dark` tie on specificity and both match <html class="dark">, so
// dark is every scope declaration in source order, last wins.
function themesOf(rules: Rule[], light: Selector, dark: Selector) {
  const base: Vars = new Map();
  const order: ["light" | "dark", string, TokenOrValue[]][] = [];
  for (const rule of rules) {
    if (rule.type === "layer-block" && layerName(rule) === "theme") {
      for (const r of rule.value.rules)
        for (const d of r.type === "style" ? body(r).normal : []) if (d.property === "custom") base.set(d.value.name, d.value.value);
    } else if (rule.type === "style") {
      const { selectors } = rule.value;
      const scope = selectors.length === 1 ? (same(selectors[0], light) ? "light" : same(selectors[0], dark) ? "dark" : undefined) : undefined;
      if (!scope) continue;
      for (const d of body(rule).normal) if (d.property === "custom") order.push([scope, d.value.name, d.value.value]);
    }
  }
  assert.ok(order.length, "no scope rule");
  const theme = (dark: boolean) => new Map([...base, ...order.flatMap(([scope, name, value]) => (dark || scope === "light" ? [[name, value] as const] : []))]);
  return { light: theme(false), dark: theme(true) };
}

function rgba(tokens: TokenOrValue[], vars: Vars, seen: string[] = []): Rgba {
  const [token, ...rest] = tokens.filter((t) => !(t.type === "token" && t.value.type === "white-space"));
  if (token?.type === "color" && !rest.length) {
    const c = token.value;
    // ponytail: only sRGB colours (hex, rgb()); a lab()/oklch() token fails loudly here, convert via lightningcss when one is added
    if (typeof c === "object" && c.type === "rgb") return [c.r, c.g, c.b, c.alpha];
    throw new Error(`cannot read colour ${JSON.stringify(c)}; use hex or rgb()`);
  }
  if (token?.type === "var" && !rest.length) {
    const name = token.value.name.ident;
    const value = vars.get(name);
    if (!value) throw new Error(`${name} is not defined`);
    if (seen.includes(name)) throw new Error(`${name} refers to itself`);
    return rgba(value, vars, [...seen, name]);
  }
  throw new Error(`cannot read a colour from ${JSON.stringify(tokens)}`);
}
const named = (vars: Vars, name: string) => rgba([{ type: "var", value: { name: { ident: `--${name}` } } }], vars);
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
const ON = "primary-foreground/primary on-lime/lime primary-text/primary-soft success/success-soft warning/warning-soft danger/danger-soft"
  .split(" ")
  .map((pair) => pair.split("/") as [string, string]);
// The check covers the token pairs globals.css defines; component-level pairs (opacity modifiers,
// literal colours) are checked by the R25 screen plans.
const PAIRS = [...TEXT.flatMap((text) => SURFACES.map((bg) => ({ text, bg }))), ...ON.map(([text, bg]) => ({ text, bg }))];
// Hive tokens with no `--color-*` mapping, so Tailwind has no utility for them: read the custom property itself.
const RAW = new Set("ink-2 primary-text surface-1 surface-2 on-lime lime primary-soft success-soft warning-soft danger danger-soft".split(" "));
const texts = new Set([...TEXT, ...ON.map(([text]) => text)]);
const surfaces = new Set([...SURFACES, ...ON.map(([, bg]) => bg)]);
// The utilities this check builds, and the one property each may declare.
const WANT = new Map<string, string>([
  ...[...texts].filter((t) => !RAW.has(t)).map((t) => [`text-${t}`, "color"] as const),
  ...[...surfaces].filter((s) => !RAW.has(s)).map((s) => [`bg-${s}`, "background-color"] as const),
  ["font-sans", "font-family"],
  ["font-mono", "font-family"],
]);
const build = async (css: string, utilities: string[]) => ast((await compile(css, { base: root, onDependency() {} })).build(utilities));
const bare = await build('@import "tailwindcss";', []);
const names = bare[0]?.type === "layer-statement" ? bare[0].value.names.flat() : [];
const THEME = (ast(":root,:host{a:b}")[0] as Extract<Rule, { type: "style" }>).value.selectors; // Tailwind's theme rule
// every custom property declared anywhere inside `rule`, however nested or wrapped (`--tw-*` are Tailwind's own)
const customs = (rule: unknown) => JSON.stringify(rule).match(/"property":"custom","value":\{"name":"--(?!tw-)[^"]*"/g) ?? [];
// An allowlist, not a hunt for overrides: the compiled stylesheet may hold only what the check can model, so an override of any
// shape (unlayered, !important, attribute/state selector, shorthand, a custom property elsewhere) throws. Also reads class -> painted value.
function audit(rules: Rule[]) {
  const utils = new Map<string, TokenOrValue[]>();
  assert.ok(same(rules[0], bare[0]), "layer order is not Tailwind's");
  for (const rule of rules) {
    const layer = layerName(rule) ?? "";
    if (rule.type === "layer-block") {
      if (!names.includes(layer)) assert.fail(`layer ${layer} is not in Tailwind's layer order`);
      for (const r of rule.value.rules) {
        if (layer !== "utilities") {
          const bad = customs(layer === "theme" && r.type === "style" && same(r.value.selectors, THEME) ? r.value.rules : r);
          if (bad.length) assert.fail(`${bad} declared in ${layer}; only scope rules and the theme layer's :root, :host may declare custom properties`);
          continue;
        }
        if (r.type !== "style") assert.fail(`${r.type} inside utilities`);
        const { normal, important, nested } = body(r);
        const [d, ...more] = normal;
        const name = [...WANT.keys()].find((k) => same(r.value.selectors, [cls(k)]));
        const prop = d?.property === "unparsed" ? d.value.propertyId.property : d?.property;
        if (!name || utils.has(name) || nested.length || important.length || more.length || prop !== WANT.get(name))
          assert.fail(`utilities may hold one plain, unique candidate class declaring only its colour/font: ${JSON.stringify(r)}`);
        utils.set(name, d?.property === "unparsed" ? d.value.value : [{ type: "color", value: d?.value } as TokenOrValue]);
      }
    } else if (rule.type === "style") {
      const { important, nested } = body(rule);
      if (important.length || nested.length || ![ROOT, DARK].some((s) => same(rule.value.selectors, [s])))
        assert.fail(`unlayered ${JSON.stringify(rule.value.selectors)} beats every layer; only plain :root and .dark scope rules may be unlayered`);
    } else if (!["layer-statement", "keyframes", "font-face", "property"].includes(rule.type)) assert.fail(`top-level ${rule.type} is outside the allowlist`);
  }
  return utils;
}

// Compile the real stylesheet, building only the utilities this check reads.
async function compiled(css: string) {
  const rules = await build(css, [...WANT.keys()]);
  return { ...themesOf(rules, ROOT, DARK), utils: audit(rules) };
}

export async function contrastFailures(css: string) {
  const { light, dark, utils } = await compiled(css);
  const failures = new Set<string>();
  const painted = (kind: "text" | "bg", name: string, vars: Vars) => {
    if (RAW.has(name)) return named(vars, name);
    const tokens = utils.get(`${kind}-${name}`);
    if (!tokens) failures.add(`${kind}-${name}: Tailwind emits no utility, so --color-${name} is missing or reset`);
    return tokens && rgba(tokens, vars);
  };
  for (const [theme, vars] of [["light", light] as const, ["dark", dark] as const]) {
    const page = named(vars, "bg");
    assert.equal(page[3], 1, `${theme} --bg must be opaque`);
    for (const { text, bg } of PAIRS) {
      const [fg, back] = [painted("text", text, vars), painted("bg", bg, vars)];
      if (!fg || !back) continue;
      const surface = over(back, page);
      const contrast = ratio(over(fg, surface), surface);
      if (contrast < AA) failures.add(`${theme}: --${text} on --${bg} is ${contrast.toFixed(2)}:1, below ${AA}:1`);
    }
  }
  return [...failures];
}

assert.deepEqual(await contrastFailures(globals), [], "contrast below WCAG AA");
// The check bites: each way of washing out a token fails by name, and each override shape the allowlist excludes throws.
const ours = await compiled(globals);
const add = (css: string) => `${globals}\n${css}\n`;
const swap = (from: string, to: string) => (assert.ok(globals.includes(from), from), globals.replace(from, to));
const MUTED = "light: --muted-foreground on --background is 1.";
const CASES: [label: string, css: string, expect: string][] = [
  ["light --muted-foreground", swap("--muted-foreground: #6b6b74;", "--muted-foreground: #bbbbbb;"), MUTED],
  ["light --muted surface", swap("--muted: var(--surface-2);", "--muted: #bbbbbb;"), "light: --muted-foreground on --muted is 2."],
  ["literal --color-*", swap("--color-muted-foreground: var(--muted-foreground);", "--color-muted-foreground: #bbbbbb;"), MUTED],
  ["--color-* reset", add("@theme inline { --color-muted-foreground: initial; }"), "text-muted-foreground: "],
  ["unmapped --color-warning", swap("--color-warning: var(--warning);", ""), "text-warning: "],
  ["later :root", add(":root { --violet: #171717; }"), "dark: --violet on --background is 1."],
  [".dark only", add(".dark { --muted-foreground: #333333; }"), "dark: --muted-foreground on --background is 1."],
  ["conditional scope", add("@media print { :root { --muted-foreground: #bbbbbb; } }"), "throws"],
  ["nested in scope", add(":root { & .x { --muted-foreground: #bbbbbb; } }"), "throws"],
  ["!important scope", add(":root { --x: 1 !important; }"), "throws"],
  ["unlayered body", add("body { --muted-foreground: #bbbbbb; }"), "throws"],
  ["utilities custom property", add("@layer utilities { body { --muted-foreground: #bbbbbb; } }"), "throws"],
  ["unlayered utility", add(".text-warning-foreground { color: #ffffff; }"), "throws"],
  ["!important utility", add("@layer utilities { .text-warning-foreground { color: #ffffff !important; } }"), "throws"],
  ["attribute selector", add('[class~="text-warning-foreground"] { color: #ffffff; }'), "throws"],
  ["background shorthand", add(".bg-background { background: #a15c00; }"), "throws"],
  ["utility :hover", add("@layer utilities { .text-violet:hover { color: #000000; } }"), "throws"],
];
for (const [label, css, expect] of CASES) {
  const found: string[] | Error = await contrastFailures(css).catch((e: Error) => e);
  const ok = expect === "throws" ? found instanceof Error : !(found instanceof Error) && found.some((f) => f.startsWith(expect));
  assert.ok(ok, `${label}: expected ${expect}, got ${found instanceof Error ? found.message : found}`);
  if (label === ".dark only") assert.ok(!(found as string[]).some((f) => f.startsWith("light:")), "light stays clean");
}

// The tokens are hive.css's values (its --muted is a text colour; here it is --muted-foreground).
const HIVE =
  "bg surface-1 surface-2 card border border-strong ink ink-2 muted primary primary-text primary-soft on-primary lime on-lime success success-soft warning warning-soft danger danger-soft focus";
const HIVE_TOKENS = HIVE.split(" ");
const hiveThemes = themesOf(ast(hive), cls("hv"), cls("hv", "dark"));
// hive.css's light --success on --success-soft is 4.49:1, below AA; globals.css lightens the surface to #e8f7ed (4.53:1).
const DEVIATIONS: Record<string, Record<string, Rgba>> = { light: { "success-soft": [0xe8, 0xf7, 0xed, 1] }, dark: {} };
for (const theme of ["light", "dark"] as const) {
  for (const token of HIVE_TOKENS) {
    const name = token === "muted" ? "muted-foreground" : token;
    const want = DEVIATIONS[theme]![token] ?? named(hiveThemes[theme], token);
    assert.deepEqual(named(ours[theme], name), want, `${theme}: --${name} should equal hive.css --${token}`);
  }
}
assert.deepEqual(ours.light.get("--radius"), hiveThemes.light.get("--radius-md"), "--radius is hive.css --radius-md");
// font stacks, tokens only: ours is `var(--font-x), <hive's stack>`
const stack = (tokens: TokenOrValue[] = []) =>
  tokens.flatMap((t) =>
    t.type === "token" && t.value.type !== "white-space" ? [t.value.type === "comma" ? "," : String(("value" in t.value && t.value.value) || "")] : [],
  );
for (const font of ["sans", "mono"]) {
  const utility = stack(ours.utils.get(`font-${font}`));
  assert.ok(utility.length, `Tailwind emits font-${font}`);
  assert.deepEqual(utility.slice(1), stack(hiveThemes.light.get(`--font-${font}`)), `--font-${font} falls back to hive.css's stack`);
}

console.log("contrast regressions passed");
