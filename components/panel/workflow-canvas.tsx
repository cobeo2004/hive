"use client";

import { X } from "lucide-react";
import dynamic from "next/dynamic";
import { type KeyboardEvent, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { chain, diffLines, meta, move, steps, tomlError } from "@/lib/workflow-chain";
import type { Edit } from "@/lib/workflow-edits";
import { PanelHeader } from "./panel-header";
import { WorkflowStepPanel } from "./workflow-step-panel";

// React Flow touches the DOM, so it loads client-only. The skeleton keeps the box sized while it loads.
const WorkflowFlow = dynamic(() => import("./workflow-flow").then((m) => m.WorkflowFlow), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-background" />,
});

// ponytail: Save as PR and Smoke test need the workflow_pr / workflow_smoke intent kinds, whose migration is held. Flip this when it merges.
const INTENTS_READY = false;
const NOTE = "Save as PR and Smoke test arrive with the workflow intents.";
const TABS = ["settings", "wiring"] as const;
type Tab = (typeof TABS)[number];

export function WorkflowCanvas({ repo, files, canEdit: admin }: { repo: string; files: Record<string, string>; canEdit: boolean }) {
  const parseError = useMemo(() => tomlError(files), [files]);
  const canEdit = admin && !parseError;
  const specs = useMemo(() => steps(files), [files]);
  const [after, setAfter] = useState<Record<string, string>>({});
  const [selected, setSelected] = useState("");
  const [tab, setTab] = useState<Tab>("settings");
  const [error, setError] = useState("");
  const [edits, setEdits] = useState<Edit[]>([]); // the step panel's field edits, kept here so Save sees them
  const [raw, setRaw] = useState<Record<string, string>>({}); // files edited as text
  const current = useMemo(() => Object.fromEntries(Object.entries(specs).map(([k, s]) => [k, { ...s, after: after[k] ?? s.after }])), [specs, after]);
  const order = chain(current);
  const diff = diffLines(specs, after);
  const dirty = diff.length > 0 || edits.length > 0 || Object.keys(raw).length > 0;
  const spec = current[selected];

  const drop = (name: string, onto: string) => {
    const res = move(current, name, onto);
    if ("error" in res) return setError(res.error);
    setError("");
    setAfter((a) => ({ ...a, ...res.after }));
  };
  const cancel = () => (setEdits([]), setRaw({}), setAfter({}), setError(""));
  // arrow keys move between the tabs, as a tablist does
  const arrows = (e: KeyboardEvent) => {
    if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
    const next = TABS[(TABS.indexOf(tab) + 1) % TABS.length];
    setTab(next);
    document.getElementById(`step-tab-${next}`)?.focus();
  };
  const wiring = spec && [
    ["Previous", order[order.indexOf(selected) - 1] ?? "—"],
    ["Next", order[order.indexOf(selected) + 1] ?? "—"],
    ["On fail", spec.on_fail ? `${spec.on_fail} (max ${spec.max_loops} loops)` : "stop and ask"],
    ["Gate", selected === "plan" ? (meta(files, spec).planGate ?? "") : spec.gate ? "on" : "off"],
  ];

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
            {/* the span carries the note: a disabled button swallows pointer events, so its own title never shows */}
            <span title={NOTE}>
              <Button variant="outline" size="sm" disabled={!INTENTS_READY}>
                Smoke test
              </Button>
            </span>
            {canEdit && (
              <span title={NOTE}>
                <Button variant={INTENTS_READY ? "default" : "outline"} size="sm" disabled={!dirty || !INTENTS_READY}>
                  Save as PR
                </Button>
              </span>
            )}
          </>
        }
      />
      <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-4 md:flex-row md:gap-6 md:overflow-hidden md:p-6">
        <div className="flex min-w-0 flex-1 flex-col gap-3 md:min-h-0">
          {parseError && <p role="alert" className="text-destructive text-sm">{`Read-only, invalid TOML ignored: ${parseError}`}</p>}
          {/* React Flow needs a sized parent: fixed on small screens, the rest of the column from md */}
          <div className="relative h-[480px] min-w-0 shrink-0 overflow-hidden rounded-lg border md:h-auto md:flex-1 md:shrink">
            <div className="absolute inset-0">
              <WorkflowFlow files={files} specs={current} canEdit={canEdit} selected={selected} onSelect={setSelected} onMove={drop} />
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-sm">
              {error}
            </p>
          )}
          <p className="text-muted-foreground text-xs">{NOTE}</p>
        </div>
        <aside className="flex shrink-0 flex-col gap-4 md:min-h-0 md:w-80 md:overflow-y-auto">
          <div className="rounded-lg border text-sm">
            {spec ? (
              <>
                <div className="flex items-center gap-2 border-b p-3">
                  <h2 className="min-w-0 flex-1 truncate font-medium">{selected}</h2>
                  <span className="rounded bg-muted px-1.5 py-0.5 text-muted-foreground text-xs">{spec.kind}</span>
                  <button
                    type="button"
                    aria-label="Close"
                    onClick={() => setSelected("")}
                    className="grid size-6 place-items-center rounded-md text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    <X aria-hidden className="size-4" />
                  </button>
                </div>
                <div role="tablist" aria-label="Step details" onKeyDown={arrows} className="flex gap-4 border-b px-3">
                  {TABS.map((t) => (
                    <button
                      key={t}
                      type="button"
                      role="tab"
                      id={`step-tab-${t}`}
                      aria-selected={tab === t}
                      aria-controls="step-tabpanel"
                      tabIndex={tab === t ? 0 : -1}
                      onClick={() => setTab(t)}
                      className={cn(
                        "-mb-px border-b-2 py-2 capitalize outline-none focus-visible:ring-2 focus-visible:ring-ring",
                        tab === t ? "border-primary text-foreground" : "border-transparent text-muted-foreground hover:text-foreground",
                      )}
                    >
                      {t}
                    </button>
                  ))}
                </div>
                <div role="tabpanel" id="step-tabpanel" aria-labelledby={`step-tab-${tab}`} className="p-3">
                  {tab === "settings" ? (
                    <WorkflowStepPanel
                      key={selected}
                      files={files}
                      specs={current}
                      name={selected}
                      canEdit={canEdit}
                      edits={edits}
                      setEdits={setEdits}
                      raw={raw}
                      setRaw={setRaw}
                    />
                  ) : (
                    <dl className="flex flex-col gap-2">
                      {wiring?.map(([k, v]) => (
                        <div key={k} className="flex justify-between gap-2">
                          <dt className="text-muted-foreground">{k}</dt>
                          <dd className="min-w-0 truncate text-right">{v}</dd>
                        </div>
                      ))}
                    </dl>
                  )}
                </div>
                {canEdit && (
                  <div className="flex justify-end gap-2 border-t p-3">
                    <Button variant="outline" size="sm" disabled={!dirty} onClick={cancel}>
                      Cancel
                    </Button>
                    <span title={NOTE}>
                      <Button variant={INTENTS_READY ? "default" : "outline"} size="sm" disabled={!dirty || !INTENTS_READY}>
                        Save
                      </Button>
                    </span>
                  </div>
                )}
              </>
            ) : (
              <p className="p-3 text-muted-foreground">Select a step.</p>
            )}
          </div>
          {diff.length > 0 && (
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
