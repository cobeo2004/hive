"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import type { WikiGraph } from "@/lib/wiki-graph";

// ponytail: a circle layout; a force layout only if it reads badly past ~30 pages.
const C = 300;
const R = 220;
const DOT = 7;

const at = (i: number, n: number) => {
  const a = -Math.PI / 2 + (2 * Math.PI * i) / n;
  return n === 1 ? { x: C, y: C, dx: 0, dy: 1 } : { x: C + R * Math.cos(a), y: C + R * Math.sin(a), dx: Math.cos(a), dy: Math.sin(a) };
};

/** The repo's wiki (R41): pages on a circle, links as arrows, a clicked page's text beside it. */
export function WikiGraphView({ graph }: { graph: WikiGraph }) {
  const [selected, setSelected] = useState("");
  const pos = new Map(graph.nodes.map((node, i) => [node.name, at(i, graph.nodes.length)]));
  const page = graph.nodes.find((n) => n.name === selected);

  if (graph.nodes.length === 0)
    return <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground">No wiki yet. Onboarding seeds one.</div>;

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:flex-row md:p-6">
      <div className="flex min-w-0 flex-1 flex-col gap-3">
        <svg viewBox="-230 40 1060 520" role="group" aria-label="Wiki pages and their links" className="w-full rounded-lg border">
          <defs>
            <marker id="wiki-arrow" viewBox="0 0 10 10" refX="10" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" className="fill-muted-foreground" />
            </marker>
          </defs>
          {graph.edges.map(([from, to]) => {
            const a = pos.get(from)!;
            const b = pos.get(to)!;
            const len = Math.hypot(b.x - a.x, b.y - a.y);
            const ux = (b.x - a.x) / len;
            const uy = (b.y - a.y) / len;
            const lit = selected === from || selected === to;
            return (
              <line
                key={`${from}>${to}`}
                x1={a.x + ux * (DOT + 2)}
                y1={a.y + uy * (DOT + 2)}
                x2={b.x - ux * (DOT + 3)}
                y2={b.y - uy * (DOT + 3)}
                markerEnd="url(#wiki-arrow)"
                className={cn(lit ? "stroke-primary" : "stroke-(--border-strong)")}
                strokeWidth={lit ? 1.75 : 1}
              />
            );
          })}
          {graph.nodes.map((node) => {
            const p = pos.get(node.name)!;
            const on = node.name === selected;
            const anchor = Math.abs(p.dx) < 0.2 ? "middle" : p.dx > 0 ? "start" : "end";
            return (
              <g
                key={node.name}
                role="button"
                tabIndex={0}
                aria-pressed={on}
                aria-label={`${node.name}${node.stale ? " (stale)" : ""}`}
                onClick={() => setSelected(on ? "" : node.name)}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.preventDefault();
                  setSelected(on ? "" : node.name);
                }}
                className="cursor-pointer outline-none [&:focus-visible>circle]:stroke-ring [&:focus-visible>circle]:stroke-3"
              >
                <title>{node.summary || node.name}</title>
                <circle
                  cx={p.x}
                  cy={p.y}
                  r={DOT}
                  className={cn(on ? "fill-primary stroke-primary" : node.stale ? "fill-(--warning-soft) stroke-warning" : "fill-background stroke-primary")}
                  strokeWidth={2}
                />
                <text
                  x={p.x + p.dx * 14}
                  y={p.y + p.dy * 14}
                  textAnchor={anchor}
                  dominantBaseline={Math.abs(p.dy) > 0.9 ? (p.dy > 0 ? "hanging" : "auto") : "middle"}
                  className={cn("text-[18px]", on ? "fill-(--primary-text) font-medium" : node.stale ? "fill-warning" : "fill-foreground")}
                >
                  {node.name}
                  {node.stale && " · stale"}
                </text>
              </g>
            );
          })}
        </svg>
        {graph.broken.length > 0 && (
          <div className="text-sm">
            <h2 className="font-medium text-destructive">Broken links</h2>
            <ul className="mt-1 text-muted-foreground">
              {graph.broken.map((b) => (
                <li key={`${b.from}>${b.target}`} className="font-mono text-xs">{`${b.from}.md → ${b.target}`}</li>
              ))}
            </ul>
          </div>
        )}
      </div>
      <aside className="flex min-h-0 shrink-0 flex-col rounded-lg border bg-card text-sm md:w-[28rem]">
        {page ? (
          <>
            <div className="shrink-0 border-b p-3">
              <h2 className="font-medium">
                {page.name}.md
                {page.stale && <span className="ml-2 rounded bg-(--warning-soft) px-1.5 py-0.5 text-warning text-xs">stale</span>}
              </h2>
              {page.summary && <p className="mt-1 text-muted-foreground">{page.summary}</p>}
            </div>
            <pre className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap p-3 font-mono text-xs">{page.text}</pre>
          </>
        ) : (
          <p className="p-3 text-muted-foreground">{`${graph.nodes.length} pages, ${graph.edges.length} links. Click a page to read it.`}</p>
        )}
      </aside>
    </div>
  );
}
