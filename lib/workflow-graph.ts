// The Workflow page's flow as plain data: chain() steps become nodes, on_fail and roles become edges. Pure TS, no react or @xyflow import;
// the shapes are structural so React Flow takes them as-is.
import { chain, meta, type Spec } from "./workflow-chain";
import { roleValues } from "./workflow-edits";

export type NodeData = {
  name: string;
  kind: Spec["kind"];
  sub: string;
  gate: boolean;
  pinned: boolean;
  wide: boolean;
  badge?: string;
  label?: string; // members only
};
export type FlowNode = {
  id: string;
  type: "step" | "member";
  position: { x: number; y: number };
  data: NodeData;
  ariaLabel?: string;
  draggable?: boolean;
  selectable?: boolean;
  focusable?: boolean;
};
export type FlowEdge = {
  id: string;
  source: string;
  target: string;
  sourceHandle: string;
  targetHandle: string;
  type: "smoothstep";
  label?: string;
  style: { stroke: string; strokeDasharray?: string };
  pathOptions?: { offset: number };
};

const SEQ = { stroke: "var(--border-strong)" };
const DOTTED = { stroke: "var(--border-strong)", strokeDasharray: "2 4" };

export function graph(files: Record<string, string>, specs: Record<string, Spec>): { nodes: FlowNode[]; edges: FlowEdge[] } {
  const order = chain(specs);
  const nodes: FlowNode[] = [];
  const edges: FlowEdge[] = [];
  const edge = (e: Omit<FlowEdge, "type">) => edges.push({ ...e, type: "smoothstep" });

  let x = 0;
  for (const name of order) {
    const spec = specs[name];
    const m = meta(files, spec);
    const pinned = name === "recon" || name === "pr";
    const wide = m.planGate === "Inbox";
    nodes.push({
      id: name,
      type: "step",
      position: { x, y: 0 },
      data: { name, kind: spec.kind, sub: m.model, gate: spec.gate, pinned, wide, badge: wide ? "Plan gate · Inbox" : undefined },
      ariaLabel: `${name}, ${spec.kind} step${pinned ? ", pinned" : ""}`,
    });

    // a panel review shows one member per entry; any other role step shows its own harness · model
    const panel = spec.kind === "role" ? roleValues(files, spec.role).panel : [];
    const labels = spec.kind !== "role" ? [] : panel.length ? panel.map((p) => [p.harness, p.model].filter(Boolean).join(" · ")) : [m.model];
    labels.forEach((label, j) => {
      const id = `${name}/m${j}`;
      nodes.push({
        id,
        type: "member",
        position: { x: wide ? x + 60 : x, y: 140 + 100 * j },
        data: { name, kind: spec.kind, sub: "", gate: false, pinned: false, wide: false, label },
        draggable: false,
        selectable: false,
        focusable: false,
      });
      edge({ id: `member:${id}`, source: name, target: id, sourceHandle: "members", targetHandle: "top", style: DOTTED });
    });
    x += wide ? 280 : 180;
  }

  order.forEach((a, i) => {
    const b = specs[a].on_fail;
    if (i) edge({ id: `seq:${order[i - 1]}->${a}`, source: order[i - 1], target: a, sourceHandle: "out", targetHandle: "in", style: SEQ });
    if (!b || !order.includes(b)) return;
    edge({
      id: `loop:${a}->${b}`,
      source: a,
      target: b,
      sourceHandle: "loop-out",
      targetHandle: "loop-in",
      label: `on_fail · max ${specs[a].max_loops}`,
      style: { stroke: "var(--violet)", strokeDasharray: "6 4" },
      pathOptions: { offset: 24 + 28 * Math.abs(i - order.indexOf(b)) }, // longer loops ride higher, so nested ones never overlap
    });
  });
  return { nodes, edges };
}
