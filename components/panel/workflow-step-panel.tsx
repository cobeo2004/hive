"use client";

import { useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { meta, readToml, type Spec } from "@/lib/workflow-chain";
import { CONFIG, changeLines, fileGate, roleFile, roleValues, stepFile, stepValues, upsert, type Edit } from "@/lib/workflow-edits";

const HARNESSES = ["claude", "codex", "cursor", "pi"];
type Key = "harness" | "model" | "effort" | "mode";
const OPTS = { harness: HARNESSES, effort: ["low", "medium", "high"], mode: ["auto", "single", "panel"] };
// ponytail: suggestions only, any model string is accepted. Refresh from T3's model manifest if the list drifts.
const MODELS = ["opus", "sonnet", "haiku", "gpt-6.1-sol", "gpt-5-codex", "auto", "composer-2", "opencode-go/deepseek-v4.1-flash", "opencode-go/kimi-k2"];
const PINNED = new Set(["recon", "pr"]); // enabled can't be switched off
const field = "rounded-md border bg-background px-2 py-1 text-sm";

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <label className="flex items-center justify-between gap-2 text-sm">
    <span>{label}</span>
    {children}
  </label>
);

// "default" is offered only while the file leaves the key unset (`unset`): picking it drops the pending edit. toml-patch sets keys, it never deletes them.
function Pick({ label, value, options, unset, onPick }: { label: string; value: string; options: string[]; unset: boolean; onPick: (v: string) => void }) {
  const all = [...(unset ? [""] : []), ...options, ...(value && !options.includes(value) ? [value] : [])];
  return (
    <select aria-label={label} value={value} onChange={(e) => onPick(e.target.value)} className={field}>
      {all.map((o) => (
        <option key={o} value={o}>
          {o || "default"}
        </option>
      ))}
    </select>
  );
}

// Commits on blur or Enter, so a half-typed model is never an edit. Empty input commits "" (back to default) if the file leaves the key `unset`, else restores the shown value.
function Text({ label, value, unset, onCommit }: { label: string; value: string; unset: boolean; onCommit: (v: string) => void }) {
  return (
    <input
      key={value}
      aria-label={label}
      list="models"
      defaultValue={value}
      placeholder="default"
      className={cn(field, "min-w-0 flex-1")}
      onBlur={(e) => {
        const v = e.currentTarget.value.trim();
        if (!v && !unset) e.currentTarget.value = value;
        else if (v !== value) onCommit(v);
      }}
      onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()}
    />
  );
}

type Files = Record<string, string>;
type Upd<T> = Dispatch<SetStateAction<T>>;
type Props = {
  files: Files;
  specs: Record<string, Spec>;
  name: string;
  canEdit: boolean;
  edits: Edit[];
  setEdits: Upd<Edit[]>;
  raw: Files;
  setRaw: Upd<Files>;
};

export function WorkflowStepPanel({ files, specs, name, canEdit, edits, setEdits, raw, setRaw }: Props) {
  const spec = specs[name];
  const [open, setOpen] = useState(""); // the path being edited as text
  const [text, setText] = useState("");
  const [error, setError] = useState("");
  // A field: its pending-or-shown value `v`, and `set`, which drops the edit when it lands back on `original` (the file's own value, if any).
  const f = <T extends Edit["value"]>(path: string, section: string, key: string, original: T | undefined, shown = original as T) => ({
    v: (edits.find((e) => e.path === path && e.section === section && e.key === key)?.value as T | undefined) ?? shown,
    set: (value: T) => setEdits((e) => upsert(e, { path, section, key, value }, original)),
  });
  const sf = stepFile(name);
  const rf = roleFile(spec.role);
  const nums = stepValues(files, spec);
  const role = spec.kind === "role" ? roleValues(files, spec.role) : null;
  const lines = changeLines(edits, raw);
  const others = Object.keys(specs).filter((n) => n !== name);
  const gate = f(sf, "", "gate", spec.gate);
  const enabled = f(sf, "", "enabled", spec.enabled);
  const onFail = f(sf, "", "on_fail", spec.on_fail);
  // plan_gate is a radio picked by onClick, not onChange: re-picking the shown default must still write.
  // It writes against the file's explicit value: Auto on a repo that sets none still writes the line
  const planGate = f(CONFIG, "unattended", "plan_gate", fileGate(files), meta(files, spec).planGate === "Inbox" ? "inbox" : "auto");
  const number = (key: "max_agents" | "min_score", original: number) => {
    const n = f(sf, "", key, original);
    return (
      <input
        type="number"
        min={0}
        aria-label={key}
        defaultValue={n.v}
        className={cn(field, "w-20")}
        onChange={(e) => e.currentTarget.valueAsNumber >= 0 && n.set(e.currentTarget.valueAsNumber)} // NaN (empty) is not >= 0
      />
    );
  };
  const note = <p className="text-muted-foreground text-xs">Edited as text; discard it to use the fields.</p>;
  const load = (path: string) => (setOpen(path), setText(raw[path] ?? files[path]), setError(""));
  const edit = (path: string, label: string) => (
    <Button variant="outline" size="sm" disabled={files[path] === undefined} onClick={() => load(path)}>
      {label}
    </Button>
  );
  const keep = () => {
    try {
      readToml(text);
    } catch (e) {
      return setError(e instanceof Error ? e.message : String(e));
    }
    setRaw({ ...raw, [open]: text });
    setEdits((e) => e.filter((x) => x.path !== open)); // the text wins: drop that file's pending field edits
    setOpen("");
  };
  const discard = () => (setRaw(Object.fromEntries(Object.entries(raw).filter(([p]) => p !== open))), setOpen(""));
  const keys: Key[] = spec.role === "review" ? ["harness", "model", "effort", "mode"] : ["harness", "model", "effort"];
  // a role-file field: a Text for model, else a Pick
  const control = (key: Key, original: string, hint = "") => {
    const x = f(rf, hint && `hint.${hint}`, key, original);
    const label = hint ? `${hint} ${key}` : key;
    if (key === "model") return <Text label={label} value={x.v} unset={original === ""} onCommit={x.set} />;
    return <Pick label={label} value={x.v} options={OPTS[key]} unset={original === ""} onPick={x.set} />;
  };

  return (
    <fieldset disabled={!canEdit} className="flex min-w-0 flex-col gap-3">
      <legend className="font-medium">{name}</legend>
      <p className="font-mono text-muted-foreground text-xs">{sf}</p>
      {name === "plan" && (
        <div role="radiogroup" aria-label="Plan gate" className="flex flex-col gap-1 text-sm">
          Gate
          {Object.entries({ auto: "Auto", inbox: "Wait in Inbox" }).map(([v, text]) => (
            <label key={v} className="flex items-center gap-2">
              <input type="radio" name="plan_gate" defaultChecked={planGate.v === v} onClick={() => planGate.set(v)} />
              {text}
            </label>
          ))}
        </div>
      )}
      {/* a file edited as text wins over its fields, so they are off until the text is discarded */}
      <fieldset disabled={raw[sf] !== undefined} className="contents">
        {raw[sf] !== undefined && note}
        {name !== "plan" && (
          <Row label="gate">
            <input type="checkbox" disabled={name === "pr"} checked={gate.v} onChange={(e) => gate.set(e.target.checked)} />
          </Row>
        )}
        <Row label="enabled">
          <input type="checkbox" disabled={PINNED.has(name)} checked={enabled.v} onChange={(e) => enabled.set(e.target.checked)} />
        </Row>
        <Row label="on_fail">
          <select value={onFail.v} onChange={(e) => onFail.set(e.target.value)} className={field}>
            <option value="">stop and ask</option>
            {others.map((n) => (
              <option key={n}>{n}</option>
            ))}
          </select>
        </Row>
        <Row label="max_agents">{number("max_agents", nums.max_agents)}</Row>
        {nums.min_score !== undefined && <Row label="min_score">{number("min_score", nums.min_score)}</Row>}
      </fieldset>
      {role && (
        <>
          <datalist id="models">
            {MODELS.map((m) => (
              <option key={m} value={m} />
            ))}
          </datalist>
          <p className="font-mono text-muted-foreground text-xs">{rf}</p>
          <fieldset disabled={raw[rf] !== undefined} className="contents">
            {raw[rf] !== undefined && note}
            {keys.map((key) => (
              <Row key={key} label={key}>
                {control(key, role[key])}
              </Row>
            ))}
            {role.panel.map((m, i) => (
              <span key={i} className="rounded-md border px-2 py-1 text-xs">
                {[m.harness, m.model, m.effort].filter(Boolean).map(String).join(" · ")}
              </span>
            ))}
            {Object.entries(role.hints).map(([hint, h]) => (
              <div key={hint} className="flex flex-col gap-1 text-sm">
                <span className="font-mono text-xs">[hint.{hint}]</span>
                <div className="flex gap-2">
                  {control("harness", h.harness, hint)}
                  {control("model", h.model, hint)}
                </div>
              </div>
            ))}
          </fieldset>
        </>
      )}
      <div className="flex flex-wrap gap-2">
        {edit(sf, "Edit step as text")}
        {role && edit(rf, "Edit role as text")}
      </div>
      {open && (
        <div className="flex flex-col gap-2">
          <p className="font-mono text-muted-foreground text-xs">{open}</p>
          <textarea
            aria-label={open}
            value={text}
            onChange={(e) => (setText(e.target.value), setError(""))}
            rows={10}
            className={cn(field, "font-mono text-xs")}
          />
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <div className="flex gap-2">
            <Button type="button" size="sm" onClick={keep}>
              Keep text
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={discard}>
              Discard
            </Button>
          </div>
        </div>
      )}
      {lines.length > 0 && (
        <pre aria-label="Changes" className="overflow-x-auto rounded-lg border p-3 font-mono text-xs">
          {lines.join("\n")}
        </pre>
      )}
    </fieldset>
  );
}
