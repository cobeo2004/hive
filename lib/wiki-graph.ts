import { posix } from "node:path";

// The repo's sstack wiki as a graph (R41), read from the runner's snapshot of main. Link rules follow
// sstack's lib/sstack_wiki.py: `.md` links outside code, minus URLs and #fragments, resolved lexically.

const DIR = ".sstack/wiki";
const PAGE = /^\.sstack\/wiki\/([^/]+)\.md$/;
const NOT_NODES = new Set(["index", "lessons"]);
const FENCE = /```[\s\S]*?```/g;
const SPAN = /`[^`\n]*`/g;
const LINK = /\]\(([^)\s]+)\)/g;
const URL = /^[a-z][a-z0-9+.-]*:/;
// sstack-wiki index writes `- [name](name.md) — summary [stale]`.
const STALE = /^- \[([^\]]+)\]\(.* \[stale\]\r?$/gm;

type WikiNode = { name: string; summary: string; text: string; stale: boolean };
export type WikiGraph = { nodes: WikiNode[]; edges: [from: string, to: string][]; broken: { from: string; target: string }[] };

/** Frontmatter is `---` on line 1 up to the next `---` line, `key: value` per line. */
function summaryOf(text: string) {
  const rows = text.split(/\r?\n/);
  const end = rows.indexOf("---", 1);
  if (rows[0] !== "---" || end < 0) return "";
  const row = rows.slice(1, end).find((r) => r.startsWith("summary: "));
  return row ? row.slice("summary: ".length).trim() : "";
}

function linkTargets(text: string) {
  const bare = text.replace(FENCE, "").replace(SPAN, "");
  return [...bare.matchAll(LINK)].map((m) => m[1]).filter((t) => !URL.test(t) && !t.startsWith("#") && t.split(/[#?]/)[0].endsWith(".md"));
}

export function wikiGraph(files: Record<string, string>): WikiGraph {
  const pages = new Map<string, string>();
  for (const [path, text] of Object.entries(files)) {
    const name = PAGE.exec(path)?.[1];
    if (name) pages.set(name, text);
  }
  const stale = new Set([...(pages.get("index") ?? "").matchAll(STALE)].map((m) => m[1]));
  const names = [...pages.keys()].filter((n) => !NOT_NODES.has(n)).sort();
  const nodes = names.map((name) => ({ name, summary: summaryOf(pages.get(name)!), text: pages.get(name)!, stale: stale.has(name) }));

  const edges: WikiGraph["edges"] = [];
  const broken: WikiGraph["broken"] = [];
  for (const { name, text } of nodes) {
    for (const target of linkTargets(text)) {
      const path = target.split(/[#?]/)[0];
      // ponytail: `~` and absolute links point outside the repo wiki, so they are neither edges nor broken.
      if (path.startsWith("/") || path.startsWith("~")) continue;
      const to = posix.normalize(posix.join(DIR, path));
      const stem = posix.basename(to, ".md");
      if (posix.dirname(to) === DIR && pages.has(stem)) {
        if (!NOT_NODES.has(stem) && stem !== name && !edges.some(([f, t]) => f === name && t === stem)) edges.push([name, stem]);
      } else if (to.startsWith(`${DIR}/`) && !broken.some((b) => b.from === name && b.target === target)) {
        broken.push({ from: name, target });
      }
    }
  }
  return { nodes, edges, broken };
}
