"use client";

import { GripVertical } from "lucide-react";
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { chain, diffLines, meta, move, steps, tomlError } from "@/lib/workflow-chain";
import { cn } from "@/lib/utils";
import { PanelHeader } from "./panel-header";

// ponytail: Save as PR and Smoke test need the workflow_pr / workflow_smoke intent kinds, whose migration is held. Flip this when it merges.
const INTENTS_READY = false;
const NOTE = "Save as PR and Smoke test arrive with the workflow intents.";
const PINNED = new Set(["recon", "pr"]);
const chip = "rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs";

export function WorkflowCanvas({ repo, files, canEdit: admin }: { repo: string; files: Record<string, string>; canEdit: boolean }) {
  const parseError = useMemo(() => tomlError(files), [files]);
  const canEdit = admin && !parseError;
  const specs = useMemo(() => steps(files), [files]);
  const [after, setAfter] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const [drag, setDrag] = useState("");
  const [error, setError] = useState("");
  const current = useMemo(() => Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { ...s, after: after[k] ?? s.after }])), [specs, after]);
  const order = chain(current);
  const diff = diffLines(specs, after);
  const dirty = diff.length > 0;

  const drop = (onto: string) => {
    const res = drag ? move(current, drag, onto) : null;
    setDrag("");
    if (!res) return;
    if ("error" in res) return setError(res.error);
    setError("");
    setAfter((a) => ({ ...a, ...res.after }));
  };

  return (
    <>
      <PanelHeader
        title={`Workflow · ${repo}`}
        actions={
          <>
            <nav aria-label="Config layer" className="flex shrink-0 items-center rounded-md border p-0.5 text-xs">
              <span aria-current="page" className="rounded-[5px] bg-accent px-2 leading-6">
                This repo · .sstack/
              </span>
            </nav>
            <Button variant="outline" size="sm" disabled={!INTENTS_READY} title={NOTE}>
              Smoke test
            </Button>
            {canEdit && (
              <Button size="sm" disabled={!dirty || !INTENTS_READY} title={NOTE}>
                Save as PR
              </Button>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-4 md:flex-row md:p-6">
        <div className="min-w-0 flex-1">
          {parseError && <p role="alert" className="mb-3 text-destructive text-sm">{`Read-only, invalid TOML ignored: ${parseError}`}</p>}
          <div className="relative pt-8">
            {/* ponytail: x is index-based, which assumes equal-width nodes (flex-1). Measure with refs if widths diverge. */}
            <svg aria-hidden viewBox="0 0 100 32" preserveAspectRatio="none" className="absolute inset-x-0 top-0 hidden h-8 w-full sm:block">
              {order.flatMap((n, i) => {
                const to = order.indexOf(current[n].on_fail);
                if (to < 0) return [];
                const x = (j: number) => ((j + 0.5) / order.length) * 100;
                return (
                  <path
                    key={n}
                    d={`M${x(i)} 32Q${(x(i) + x(to)) / 2} 0 ${x(to)} 32`}
                    className="fill-none stroke-destructive"
                    strokeDasharray="4 3"
                    vectorEffect="non-scaling-stroke"
                  />
                );
              })}
            </svg>
            <ol className="flex flex-col gap-8 sm:flex-row sm:gap-4">
              {order.map((name, i) => {
                const spec = current[name];
                const { model, planGate } = meta(files, spec);
                const grip = canEdit && !PINNED.has(name);
                return (
                  <li
                    key={name}
                    draggable={grip}
                    onDragStart={grip ? () => setDrag(name) : undefined}
                    onDragOver={(e) => e.preventDefault()}
                    onDrop={() => drop(name)}
                    className="relative flex min-w-0 flex-1"
                  >
                    <button
                      type="button"
                      onClick={() => setSelected(name)}
                      className={cn(
                        "flex min-w-0 flex-1 flex-col items-start gap-1 rounded-lg border p-3 text-left",
                        selected === name && "ring-2 ring-primary",
                      )}
                    >
                      <span className="text-muted-foreground text-xs">{spec.kind}</span>
                      <span className="font-medium">{name}</span>
                      <span className="truncate text-muted-foreground text-xs">{model}</span>
                      <span className="flex flex-wrap gap-1">
                        {spec.gate && <span className={chip}>gate</span>}
                        {planGate && <span className={chip}>{planGate}</span>}
                        {PINNED.has(name) && <span title="Pinned">📌</span>}
                      </span>
                    </button>
                    {grip && <GripVertical aria-label={`Drag ${name}`} className="absolute top-2 right-1 size-4 cursor-grab text-muted-foreground" />}
                    {i < order.length - 1 && (
                      <span
                        aria-hidden
                        className="absolute -bottom-6 left-1/2 text-muted-foreground sm:top-1/2 sm:right-[-1.1rem] sm:bottom-auto sm:left-auto sm:-translate-y-1/2"
                      >
                        <span className="sm:hidden">↓</span>
                        <span className="hidden sm:inline">→</span>
                      </span>
                    )}
                  </li>
                );
              })}
            </ol>
          </div>
          {error && (
            <p role="alert" className="mt-3 text-destructive text-sm">
              {error}
            </p>
          )}
          <p className="mt-4 text-muted-foreground text-xs">{NOTE}</p>
        </div>
        <aside className="flex shrink-0 flex-col gap-4 md:w-72">
          <div className="rounded-lg border p-3 text-sm">
            {selected && current[selected] ? (
              <>
                <p className="font-medium">{selected}</p>
                <p className="font-mono text-muted-foreground text-xs">.sstack/steps/{selected}/step.toml</p>
              </>
            ) : (
              <p className="text-muted-foreground">Select a step.</p>
            )}
            <div data-slot="step-panel" />
          </div>
          {dirty && (
            <pre className="overflow-x-auto rounded-lg border p-3 font-mono text-xs">
              {diff.map((d) => (
                <span key={d.path} className="block">
                  <span className="block text-muted-foreground">{d.path}</span>
                  <span className="block text-destructive">- {d.from}</span>
                  <span className="block text-success">+ {d.to}</span>
                </span>
              ))}
            </pre>
          )}
        </aside>
      </div>
    </>
  );
}
