import { isDeepStrictEqual } from "node:util";

// Sets one `key = value` in a TOML text, every other byte alone. A line patcher picks where to edit; Bun's TOML
// parser is the arbiter: the result must parse to the original plus that value, else it throws. ponytail: this
// runs under Bun (the runner), not the Node panel; bare dotted sections and bare keys only.
declare const Bun: { TOML: { parse(text: string): unknown } };
const KEY = /^[A-Za-z0-9_-]+$/;
const EOL = /\r?\n$/;
// Strings and comments blanked in place (newlines kept): a line inside a multi-line string or only a
// comment reads as blank, and quotes or brackets in either never count. ponytail: regex tokens only.
const TEXT = /"""(?:\\[^]|[^\\])*?"""|'''[^]*?'''|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|#.*/g;
const plain = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && Object.getPrototypeOf(v) === Object.prototype;

/** Replaces `key` inside `[section]` (the top level when `section` is ""), or inserts it at the end of that section. */
export function patch(text: string, section: string, key: string, value: string | number | boolean): string {
  const name = `${section ? `[${section}] ` : ""}${key}`;
  if (section && !/^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)*$/.test(section)) throw new Error(`toml-patch: section must be bare dotted keys: ${section}`);
  if (!KEY.test(key)) throw new Error(`toml-patch: key must be bare: ${key}`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`toml-patch: number must be finite: ${name}`);
  if (typeof value === "string" && !value.isWellFormed()) throw new Error(`toml-patch: string must be well-formed: ${name}`);
  const parse = (t: string, what: string) => {
    try {
      return Bun.TOML.parse(t);
    } catch (error) {
      throw new Error(`toml-patch: ${what} is not valid TOML: ${name}`, { cause: error });
    }
  };
  const expected = parse(text, "the file") as Record<string, unknown>; // edited in place into what the result must parse to
  let table = expected;
  for (const part of section ? section.split(".") : []) {
    const next = Object.hasOwn(table, part) ? table[part] : (table[part] = {});
    if (!plain(next)) throw new Error(`toml-patch: ${part} is not a plain table: ${name}`);
    table = next;
  }
  table[key] = value;
  const result = edit(text, section, key, typeof value === "string" ? JSON.stringify(value) : String(value));
  if (!isDeepStrictEqual(parse(result, "the result"), expected)) throw new Error(`toml-patch: patching would change more than ${name}`);
  return result;
}

function edit(text: string, section: string, key: string, rendered: string): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text ? text.split(/(?<=\n)/) : [];
  const code = text.replace(TEXT, (t) => t.replace(/[^\n]/g, " ")).split(/(?<=\n)/);
  let depth = 0;
  const inValue = code.map((line) => {
    const was = depth > 0; // inside a multi-line array or inline table
    for (const c of line) depth = Math.max(0, depth + ("[{".includes(c) ? 1 : "]}".includes(c) ? -1 : 0));
    return was;
  });
  const isHeader = (i: number) => !inValue[i] && /^\s*\[/.test(code[i]!);
  const nameOf = (i: number) => /^\s*\[([^[\]]*)\]\s*$/.exec(code[i]!)?.[1]?.replace(/\s/g, ""); // a quoted name is blanked, so never equals a bare section
  let start = 0;
  if (section) {
    const at = lines.findIndex((_, i) => isHeader(i) && nameOf(i) === section);
    if (at < 0) {
      const head = text && !text.endsWith("\n") ? text + eol : text;
      return `${head}${head ? eol : ""}[${section}]${eol}${key} = ${rendered}${eol}`;
    }
    start = at + 1;
  }
  let end = start;
  while (end < lines.length && !isHeader(end)) end++;
  const full = /^(\s*)([A-Za-z0-9_-]+)(\s*=\s*)((?:"(?:[^"\\]|\\.)*"|'[^']*'|[^#"'])*?)(\s*(?:#.*)?)$/;
  for (let i = start; i < end; i++) {
    const match = inValue[i] || !code[i]!.trim() ? null : full.exec(lines[i]!.replace(EOL, ""));
    if (!match || match[2] !== key) continue;
    lines[i] = `${match[1]}${match[2]}${match[3]}${rendered}${match[5]}${EOL.exec(lines[i]!)?.[0] ?? ""}`;
    return lines.join("");
  }
  let last = end - 1;
  while (last >= start && !lines[last]!.trim()) last--;
  const at = last < start ? start : last + 1;
  if (at > 0 && !EOL.test(lines[at - 1]!)) lines[at - 1] += eol; // the header line too
  lines.splice(at, 0, `${key} = ${rendered}${eol}`);
  return lines.join("");
}
