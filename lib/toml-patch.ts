// Sets one `key = value` in a TOML text and leaves every other byte alone, so a one-field change
// is a one-line diff. A line patcher, not a parser. ponytail: single-line values only; multi-line
// values, quoted or dotted keys and escaped quoted keys throw. Add a real parser if a field ever needs one.

const HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const KEY = /^[A-Za-z0-9_-]+$/;
const EOL = /\r?\n$/;
const SEG = /"(?:[^"\\\n]|\\.)*"|'[^'\n]*'|[\w-]+/g;
const DEF = new RegExp(`^\\s*(\\[\\[?\\s*)?((?:${SEG.source})(?:\\s*\\.\\s*(?:${SEG.source}))*)\\s*(=|\\])`); // header or assignment

const render = (value: string | number | boolean) => (typeof value === "string" ? JSON.stringify(value) : String(value));
const bodyOf = (line: string) => line.replace(EOL, "");

// Strings and comments blanked in place (newlines kept): a line inside a multi-line string or only a
// comment reads as blank, and quotes or brackets in either never count. ponytail: regex tokens only.
const TEXT = /"""(?:\\[^]|[^\\])*?"""|'''[^]*?'''|"(?:[^"\\\n]|\\.)*"?|'[^'\n]*'?|#.*/g;

/** Replaces `key` inside `[section]` (the top level when `section` is ""), or inserts it at the end of that section. */
export function patch(text: string, section: string, key: string, value: string | number | boolean): string {
  if (!KEY.test(key)) throw new Error(`toml-patch: key must be bare: ${key}`);
  if (typeof value === "number" && !Number.isFinite(value)) throw new Error(`toml-patch: number must be finite: ${key}`);
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const rendered = render(value);
  const lines = text ? text.split(/(?<=\n)/) : [];
  const code = text.replace(TEXT, (t) => t.replace(/[^\n]/g, " ")).split(/(?<=\n)/);
  let depth = 0;
  const inValue = code.map((line) => {
    const was = depth > 0; // inside a multi-line array or inline table
    for (const c of line) depth = Math.max(0, depth + ("[{".includes(c) ? 1 : "]}".includes(c) ? -1 : 0));
    return was;
  });
  const isHeader = (i: number) => !inValue[i] && /^\s*\[/.test(code[i]!);
  const nameOf = (i: number) => HEADER.exec(bodyOf(lines[i]!))?.[1]?.replace(/\s*\.\s*/g, ".");
  // Every key line outside values: refuse escaped quoted keys; `taken` = a header ([[x]], ["a.b"]) or assignment (`a = {..}`, `a.b.k = 1`) defines `section`.
  const want = section.split(".");
  let [table, taken]: [string[], boolean] = [[], false];
  lines.forEach((line, i) => {
    const m = inValue[i] || !code[i]!.trim() ? null : DEF.exec(line);
    if (!m || !!m[1] !== (m[3] === "]")) return;
    if (m[2]!.includes("\\")) throw new Error("toml-patch: quoted key with an escape sequence is unsupported");
    const path = m[2]!.match(SEG)!.map((s) => (/^["']/.test(s) ? s.slice(1, -1) : s));
    if (m[1]) table = path;
    const eff = m[1] ? path : [...table, ...path];
    taken ||= m[1] ? eff.join(".") === section : eff.every((s, j) => s === want[j]) || (want.length > table.length && want.every((s, j) => s === eff[j]));
  });
  let start = 0;
  if (section) {
    const at = lines.findIndex((_, i) => isHeader(i) && nameOf(i) === section && !/^\s*\[\[/.test(lines[i]!));
    if (at < 0) {
      if (taken) throw new Error(`toml-patch: section may already exist: ${section}`);
      const head = text && !text.endsWith("\n") ? text + eol : text;
      return `${head}${head ? eol : ""}[${section}]${eol}${key} = ${rendered}${eol}`;
    }
    start = at + 1;
  }
  let end = start;
  while (end < lines.length && !isHeader(end)) end++;
  const prefix = new RegExp(`^(\\s*${key}\\s*=\\s*)`);
  const full = new RegExp(`^(\\s*${key}\\s*=\\s*)((?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|[^#"'])*?)(\\s*(?:#.*)?)$`);
  const unsupported = new RegExp(`^\\s*(?:["']${key}["']\\s*[=.]|${key}\\s*\\.)`); // quoted or dotted
  for (let i = start; i < end; i++) {
    if (inValue[i] || !code[i]!.trim()) continue;
    const body = bodyOf(lines[i]!);
    if (unsupported.test(body)) throw new Error(`toml-patch: quoted key unsupported: ${key}`);
    if (!prefix.test(body)) continue;
    const match = full.exec(body);
    const old = match?.[2] ?? "";
    if (!match || /^("""|''')/.test(old) || (old.startsWith("[") && !old.endsWith("]")) || (old.startsWith("{") && !old.endsWith("}")))
      throw new Error(`toml-patch: ${key} has a multi-line or unreadable value`);
    lines[i] = `${match[1]}${rendered}${match[3]}${EOL.exec(lines[i]!)?.[0] ?? ""}`;
    return lines.join("");
  }

  let last = end - 1;
  while (last >= start && !lines[last]!.trim()) last--;
  const at = last < start ? start : last + 1;
  if (at > 0 && !EOL.test(lines[at - 1]!)) lines[at - 1] += eol; // the header line too
  lines.splice(at, 0, `${key} = ${rendered}${eol}`);
  return lines.join("");
}
