"use client";

// The Workflow page's flow editor. The only file that imports @xyflow/react; the canvas loads it client-only (dynamic, ssr: false).
import "@xyflow/react/dist/style.css";
import {
  Background,
  BackgroundVariant,
  type Edge,
  Handle,
  type Node,
  type NodeProps,
  Panel,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useNodesState,
  useReactFlow,
  useStore,
  useStoreApi,
  useViewport,
} from "@xyflow/react";
import { Bot, Cpu, GitPullRequestArrow, Minus, Pin, Plus, SquareTerminal } from "lucide-react";
import { type KeyboardEvent, useEffect, useMemo, useRef } from "react";
import { cn } from "@/lib/utils";
import type { Spec } from "@/lib/workflow-chain";
import { graph, type NodeData } from "@/lib/workflow-graph";

type FlowNode = Node<NodeData>;
const ICON = { role: Bot, command: SquareTerminal, inline: GitPullRequestArrow } as const;
// RF's stylesheet is unlayered and sets the handle's look, so hiding it is inline; the handles only anchor edges.
const HIDDEN = { opacity: 0 } as const;
const FIT = { padding: 0.15, maxZoom: 1 } as const;
const chip = "inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs";

function StepNode({ data, selected }: NodeProps<FlowNode>) {
  const Icon = ICON[data.kind];
  const ring = selected && "ring-2 ring-ring";
  return (
    <div className={cn("relative flex flex-col items-center gap-1", data.wide ? "w-[220px]" : "w-[110px]")}>
      {data.wide ? (
        <div
          className={cn(
            "tile relative flex h-14 w-full items-center gap-2 rounded-lg border-2 border-[var(--lime)] bg-card px-2 outline outline-1 outline-[var(--border-strong)]",
            ring,
          )}
        >
          <Icon aria-hidden className="size-5 shrink-0 text-foreground" />
          <span className="flex min-w-0 flex-1 flex-col text-left">
            <span className="truncate font-medium text-foreground text-sm">{data.name}</span>
            <span className="truncate text-muted-foreground text-xs">{data.sub}</span>
          </span>
          <span className={cn(chip, "shrink-0 bg-[var(--lime)] font-medium text-[var(--on-lime)]")}>{data.badge}</span>
          <Ports />
        </div>
      ) : (
        <div className={cn("tile relative grid size-14 place-items-center rounded-lg border bg-card", ring)}>
          <Icon aria-hidden className="size-6 text-foreground" />
          <Ports />
        </div>
      )}
      {!data.wide && (
        <>
          <span className="max-w-full truncate font-medium text-foreground text-sm">{data.name}</span>
          <span className="max-w-full truncate text-muted-foreground text-xs">{data.sub}</span>
        </>
      )}
      {!data.wide && (data.gate || data.pinned) && (
        <span className="flex items-center gap-1">
          {data.gate && <span className={cn(chip, "bg-[var(--warning-soft)] text-warning")}>gate</span>}
          {data.pinned && (
            <span className={cn(chip, "text-muted-foreground")}>
              <Pin aria-hidden className="size-3" />
              pinned
            </span>
          )}
        </span>
      )}
      <Handle id="members" type="source" position={Position.Bottom} isConnectable={false} style={HIDDEN} />
    </div>
  );
}

// the handles that sit on the tile: sequence in/out at the sides, on_fail loops on top
function Ports() {
  return (
    <>
      <Handle id="in" type="target" position={Position.Left} isConnectable={false} style={HIDDEN} />
      <Handle id="out" type="source" position={Position.Right} isConnectable={false} style={HIDDEN} />
      <Handle id="loop-in" type="target" position={Position.Top} isConnectable={false} style={{ ...HIDDEN, left: "35%" }} />
      <Handle id="loop-out" type="source" position={Position.Top} isConnectable={false} style={{ ...HIDDEN, left: "65%" }} />
    </>
  );
}

function MemberNode({ data }: NodeProps<FlowNode>) {
  return (
    <div className="flex w-[110px] flex-col items-center gap-1">
      <div className="relative grid size-9 place-items-center rounded-full border bg-card">
        <Cpu aria-hidden className="size-4 text-muted-foreground" />
        <Handle id="top" type="target" position={Position.Top} isConnectable={false} style={HIDDEN} />
      </div>
      <span className="max-w-full truncate text-muted-foreground text-xs">{data.label}</span>
    </div>
  );
}

const nodeTypes = { step: StepNode, member: MemberNode };

function Zoom() {
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const { zoom } = useViewport();
  const btn = "grid h-7 min-w-7 place-items-center px-1.5 text-foreground text-xs outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring";
  return (
    <Panel position="bottom-left" className="flex items-center overflow-hidden rounded-md border bg-card">
      <button type="button" aria-label="Zoom out" className={btn} onClick={() => zoomOut()}>
        <Minus aria-hidden className="size-4" />
      </button>
      <button type="button" aria-label="Fit view" className={cn(btn, "w-12 tabular-nums")} onClick={() => fitView({ ...FIT, duration: 200 })}>
        {Math.round(zoom * 100)}%
      </button>
      <button type="button" aria-label="Zoom in" className={btn} onClick={() => zoomIn()}>
        <Plus aria-hidden className="size-4" />
      </button>
    </Panel>
  );
}

type Props = {
  files: Record<string, string>;
  specs: Record<string, Spec>;
  canEdit: boolean;
  selected: string;
  onSelect: (name: string) => void;
  onMove: (name: string, onto: string) => void;
  cover: number; // px a floating panel hides on the right from md up
};

function Flow({ files, specs, canEdit, selected, onSelect, onMove, cover }: Props) {
  const built = useMemo(() => graph(files, specs), [files, specs]);
  const [nodes, setNodes, onNodesChange] = useNodesState<FlowNode>(built.nodes);
  const { getIntersectingNodes, fitView, getNode, getViewport, setViewport } = useReactFlow();
  const store = useStoreApi();
  const width = useStore((s) => s.width);
  const grab = useRef<{ at: { x: number; y: number }; members: Record<string, { x: number; y: number }> } | null>(null);
  useEffect(() => setNodes(built.nodes), [built, setNodes]); // free positions last until the chain or specs change
  // re-fit when the canvas itself resizes (the window); the panel floats, so opening or closing it never does
  useEffect(() => {
    if (width) void fitView({ ...FIT, duration: 200 });
  }, [width, fitView]);
  // selecting a step pans (zoom unchanged) so it sits mid-way in the part of the canvas the panel leaves visible; closing moves nothing
  useEffect(() => {
    const node = selected ? getNode(selected) : undefined;
    if (!node) return;
    const { width: w, height: h } = store.getState();
    const hidden = window.matchMedia("(min-width: 768px)").matches ? cover : 0; // below md the panel stacks under the canvas
    const { zoom } = getViewport();
    const cx = node.position.x + (node.measured?.width ?? 0) / 2;
    const cy = node.position.y + (node.measured?.height ?? 0) / 2;
    void setViewport({ x: (w - hidden) / 2 - cx * zoom, y: h / 2 - cy * zoom, zoom }, { duration: 200 });
  }, [selected, cover, getNode, getViewport, setViewport, store]);
  // the canvas owns which step is open, so the ring follows it (closing the panel clears it)
  const shown = useMemo(() => nodes.map((n) => (n.selected === (n.id === selected) ? n : { ...n, selected: n.id === selected })), [nodes, selected]);
  // loop labels read violet on a card chip, like the edge itself
  const edges = useMemo<Edge[]>(
    () => built.edges.map((e) => (e.label ? { ...e, labelStyle: { fill: "var(--violet)" }, labelBgStyle: { fill: "var(--card)" } } : e)),
    [built],
  );

  // members follow their step while it is free-dragged (visual only)
  const pick = (_: unknown, node: FlowNode) => {
    const members = Object.fromEntries(nodes.filter((n) => n.type === "member" && n.id.startsWith(`${node.id}/`)).map((n) => [n.id, n.position]));
    grab.current = { at: node.position, members };
  };
  const follow = (_: unknown, node: FlowNode) => {
    const g = grab.current;
    if (!g) return;
    const [dx, dy] = [node.position.x - g.at.x, node.position.y - g.at.y];
    setNodes((ns) => ns.map((n) => (g.members[n.id] ? { ...n, position: { x: g.members[n.id]!.x + dx, y: g.members[n.id]!.y + dy } } : n)));
  };
  const drop = (_: unknown, node: FlowNode) => {
    const onto = getIntersectingNodes(node).find((n) => n.type === "step" && n.id !== node.id);
    if (!onto) return; // free drag is visual only: it stays where it was dropped
    onMove(node.id, onto.id);
    setNodes(built.nodes); // a refused move snaps back; an accepted one rebuilds the graph anyway
  };
  const enter = (e: KeyboardEvent) => {
    if (e.key !== "Enter") return;
    const id = (e.target as HTMLElement).closest(".react-flow__node")?.getAttribute("data-id");
    if (id && specs[id]) onSelect(id);
  };

  return (
    <ReactFlow
      nodes={shown}
      edges={edges}
      nodeTypes={nodeTypes}
      onNodesChange={onNodesChange}
      fitView
      fitViewOptions={FIT}
      minZoom={0.4}
      nodesDraggable={canEdit}
      nodesConnectable={false}
      edgesFocusable={false}
      onNodeClick={(_, n) => n.type === "step" && onSelect(n.id)}
      onNodeDragStart={pick}
      onNodeDrag={follow}
      onNodeDragStop={drop}
      onKeyDown={enter}
      attributionPosition="top-left" // bottom-right is under the floating panel, bottom-left holds the zoom controls
      aria-label="Workflow steps"
      className="[&_.react-flow__attribution_a]:text-muted-foreground [&_.react-flow__node:focus-visible_.tile]:ring-2 [&_.react-flow__node:focus-visible_.tile]:ring-ring"
      style={
        {
          "--xy-background-color": "var(--bg)",
          "--xy-edge-label-background-color": "var(--card)",
          "--xy-edge-label-color": "var(--ink-2)",
          "--xy-attribution-background-color": "transparent",
        } as React.CSSProperties
      }
    >
      <Background variant={BackgroundVariant.Dots} gap={16} size={1} color="var(--border-strong)" />
      <Zoom />
    </ReactFlow>
  );
}

export function WorkflowFlow(props: Props) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
