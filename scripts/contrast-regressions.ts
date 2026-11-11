import "./test-guard";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
// ponytail: @tailwindcss/node and lightningcss are hoisted transitive installs (from @tailwindcss/postcss); package.json is held by the ticket, declare them when it opens up.
import { compile } from "@tailwindcss/node";
import { type Rule, type Selector, type TokenOrValue, transform } from "lightningcss";

// R25a: app/globals.css wears design/screens/hive.css's tokens, and every text/background pair it
// defines reads at WCAG AA (4.5:1) in both themes. Nothing here parses CSS by hand: globals.css is compiled
// by Tailwind and read through lightningcss's AST, so what is checked is the colour a utility really paints.
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

// The custom properties a stylesheet declares for the `light` scope and, over it, the `dark` scope. `:root` and `.dark`
// tie on specificity and both match <html class="dark">, so dark is every scope rule in source order, last wins. Anything
// the cascade would guess at throws: a conditional/layered/nested/compound scope rule, `!important`, and (with `guard`,
// a set of `--token` and `class` names) any other non-utilities rule redeclaring a guarded property or utility colour.
function themesOf(rules: Rule[], light: Selector, dark: Selector, guard?: Set<string>) {
  const base: Vars = new Map();
  const order: ["light" | "dark", string, TokenOrValue[]][] = [];
  const reject = (why: string): never => {
    throw new Error(`custom properties must be unconditional and unlayered, on a plain scope rule: ${why}`);
  };
  const walk = (list: Rule[], top: boolean, inUtilities: boolean) => {
    for (const rule of list) {
      if (layerName(rule) === "theme" && rule.type === "layer-block") {
        for (const r of rule.value.rules)
          for (const d of r.type === "style" ? body(r).normal : []) if (d.property === "custom") base.set(d.value.name, d.value.value);
      } else if (rule.type === "style") {
        const { selectors } = rule.value;
        const { normal, important, nested } = body(rule);
        const props = [...normal, ...important];
        const scope = selectors.length === 1 ? (same(selectors[0], light) ? "light" : same(selectors[0], dark) ? "dark" : undefined) : undefined;
        if (!scope) {
          const mentions = selectors.some((s) => [light, dark].some((c) => c.every((x) => s.some((y) => same(y, x)))));
          const classes = selectors.flat().flatMap((c) => (c.type === "class" ? [c.name] : []));
          for (const d of props) {
            const prop = d.property === "unparsed" ? d.value.propertyId.property : d.property;
            if (d.property === "custom" && mentions) reject(`${JSON.stringify(selectors)} is not a plain scope selector`);
            const hit = (d.property === "custom" ? [d.value.name] : prop === "color" || prop === "background-color" ? classes : []).find((n) => guard?.has(n));
            if (hit && !inUtilities) throw new Error(`${JSON.stringify(selectors)} overrides ${hit} outside the utilities layer`);
          }
          walk(nested, false, inUtilities);
          continue;
        }
        if (nested.length) reject("a nested rule inside a scope rule");
        if (!top && props.some((d) => d.property === "custom")) reject("a scope rule inside an at-rule");
        for (const d of important) if (d.property === "custom") reject(`${d.value.name} is !important`);
        for (const d of normal) if (d.property === "custom") order.push([scope, d.value.name, d.value.value]);
      } else if ("value" in rule && rule.value && typeof rule.value === "object" && "rules" in rule.value) {
        walk(rule.value.rules as Rule[], false, inUtilities || layerName(rule) === "utilities");
      }
    }
  };
  walk(rules, true, false);
  assert.ok(order.length, "no scope rule");
  const theme = (dark: boolean) => new Map([...base, ...order.flatMap(([scope, name, value]) => (dark || scope === "light" ? [[name, value] as const] : []))]);
  return { light: theme(false), dark: theme(true) };
}

// What Tailwind's utilities declare, by `<class>/<property>`: the colour/font tokens still holding `var(--x)`.
function utilities(rules: Rule[]) {
  const out = new Map<string, TokenOrValue[]>();
  for (const layer of rules) {
    if (layer.type !== "layer-block" || layerName(layer) !== "utilities") continue;
    for (const rule of layer.value.rules) {
      const sel = rule.type === "style" ? rule.value.selectors[0]?.[0] : undefined;
      if (rule.type !== "style" || sel?.type !== "class") continue;
      for (const d of body(rule).normal) {
        if (d.property === "unparsed") out.set(`${sel.name}/${d.value.propertyId.property}`, d.value.value);
        else if (d.property === "color" || d.property === "background-color") out.set(`${sel.name}/${d.property}`, [{ type: "color", value: d.value }]);
      }
    }
  }
  return out;
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
const MAPPED = [...[...texts].map((t) => `text-${t}`), ...[...surfaces].map((s) => `bg-${s}`)].filter((u) => !RAW.has(u.replace(/^(text|bg)-/, "")));

const GUARD = new Set([...[...texts, ...surfaces, "bg"].map((t) => `--${t}`), ...MAPPED]);

// Compile the real stylesheet; `rules` is the AST of what Tailwind would ship for the utilities this check reads.
async function compiled(css: string) {
  const compiler = await compile(css, { base: root, onDependency() {} });
  const rules = ast(compiler.build([...MAPPED, "font-sans", "font-mono"]));
  return { ...themesOf(rules, ROOT, cls("dark"), GUARD), utils: utilities(rules) };
}

export async function contrastFailures(css: string) {
  const { light, dark, utils } = await compiled(css);
  const failures: string[] = [];
  const missing = new Set<string>();
  const painted = (kind: "text" | "bg", name: string, vars: Vars) => {
    if (RAW.has(name)) return named(vars, name);
    const tokens = utils.get(`${kind}-${name}/${kind === "text" ? "color" : "background-color"}`);
    if (!tokens) missing.add(`${kind}-${name}: Tailwind emits no utility, so --color-${name} is missing or reset`);
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
      if (contrast < AA) failures.push(`${theme}: --${text} on --${bg} is ${contrast.toFixed(2)}:1, below ${AA}:1`);
    }
  }
  return [...missing, ...failures];
}

const failures = await contrastFailures(globals);
assert.deepEqual(failures, [], `contrast below WCAG AA:\n${failures.join("\n")}`);

// The check bites: each way of washing out a token fails by name, and each cascade guess throws or is modelled.
const ours = await compiled(globals);
const fails = async (css: string, prefix: string) => {
  const found = await contrastFailures(css);
  assert.ok(
    found.some((f) => f.startsWith(prefix)),
    `${prefix} is missing from ${found}`,
  );
  return found;
};
const swap = (from: string, to: string) => (assert.ok(globals.includes(from), from), globals.replace(from, to));
const throws = (css: string, why: RegExp) => assert.rejects(contrastFailures(`${globals}\n${css}\n`), why);
const MUTED = "light: --muted-foreground on --background is 1.";
await fails(swap("--muted-foreground: #6b6b74;", "--muted-foreground: #bbbbbb;"), MUTED);
await fails(swap("--muted: var(--surface-2);", "--muted: #bbbbbb;"), "light: --muted-foreground on --muted is 2.");
await fails(swap("--color-muted-foreground: var(--muted-foreground);", "--color-muted-foreground: #bbbbbb;"), MUTED);
await fails(`${globals}\n@theme inline { --color-muted-foreground: initial; }\n`, "text-muted-foreground: ");
// both scopes match <html class="dark">, so a later :root wins there; neither touches light, and .dark keeps what a later :root leaves alone
for (const scope of [":root", ".dark"]) {
  const found = await fails(`${globals}\n${scope} { --muted-foreground: #333333; }\n`, "dark: --muted-foreground on --background is 1.");
  assert.ok(!found.some((f) => f.startsWith("light:")), `${scope} only changes dark`);
}
const kept = await compiled(`${globals}\n:root { --radius: 1px; }\n`);
assert.deepEqual(kept.dark.get("--background"), ours.dark.get("--background"), "a later :root keeps the .dark values it does not redeclare");
await throws("@media print { :root { --muted-foreground: #bbbbbb; } }", /unconditional and unlayered/);
await throws(":root { & .x { --muted-foreground: #bbbbbb; } }", /plain scope selector/);
await throws(":root { --secondary-foreground: #bbbbbb !important; }", /!important/);
await throws("body { --muted-foreground: #bbbbbb; }", /--muted-foreground outside the utilities layer/);
await throws(".text-warning-foreground { color: #ffffff; }", /text-warning-foreground outside the utilities layer/);

// The tokens are hive.css's values. hive.css's --muted is a text colour; here it is --muted-foreground.
const HIVE_TOKENS: Record<string, string> = Object.fromEntries(
  "bg surface-1 surface-2 card border border-strong ink ink-2 muted primary primary-text primary-soft on-primary lime on-lime success success-soft warning warning-soft danger danger-soft focus"
    .split(" ")
    .map((t) => [t, t === "muted" ? "muted-foreground" : t]),
);
const hiveThemes = themesOf(ast(hive), cls("hv"), cls("hv", "dark"));
// hive.css's light --success on --success-soft is 4.49:1, below AA; globals.css lightens the surface to #e8f7ed (4.53:1).
const DEVIATIONS: Record<string, Record<string, Rgba>> = { light: { "success-soft": [0xe8, 0xf7, 0xed, 1] }, dark: {} };
for (const theme of ["light", "dark"] as const) {
  for (const [token, name] of Object.entries(HIVE_TOKENS)) {
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
  const utility = stack(ours.utils.get(`font-${font}/font-family`));
  assert.ok(utility.length, `Tailwind emits font-${font}`);
  assert.deepEqual(utility.slice(1), stack(hiveThemes.light.get(`--font-${font}`)), `--font-${font} falls back to hive.css's stack`);
}

console.log("contrast regressions passed");
