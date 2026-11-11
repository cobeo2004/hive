"use client";

import { motion } from "motion/react";
import type { ReactNode } from "react";
import { Kbd } from "@/components/ui/kbd";
import { cn } from "@/lib/utils";
import type { OwnerView } from "@/lib/inbox";
import type { JobView } from "./job-view";
import type { FeedStatus } from "./live-refresh";

const STATUS: Record<FeedStatus, { dot: string; label: string }> = {
  live: { dot: "animate-pulse bg-success", label: "Live" },
  connecting: { dot: "bg-warning", label: "Connecting" },
  off: { dot: "bg-faint", label: "Live updates off in previews" },
};

const JOB_VIEWS: readonly { value: JobView; label: string }[] = [
  { value: "board", label: "Board" },
  { value: "list", label: "List" },
];

/** A segmented switch: its label names the group for screen readers and keeps each group's marker apart. */
export type SwitchProps<T extends string> = { label: string; options: readonly { value: T; label: string }[]; current: T; onChange: (value: T) => void };

function ViewSwitch<T extends string>({ label: group, options, current, onChange }: SwitchProps<T>) {
  return (
    <div role="radiogroup" aria-label={group} className="flex shrink-0 items-center rounded-md border p-0.5">
      {options.map(({ value, label }) => (
        <button
          key={value}
          type="button"
          onClick={() => value !== current && onChange(value)}
          role="radio"
          aria-checked={value === current}
          className={cn(
            "relative h-6 rounded-[5px] px-2 text-xs leading-6 outline-none focus-visible:ring-2 focus-visible:ring-ring",
            value === current ? "text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {value === current && (
            <motion.span
              layoutId={`panel-view-marker-${group}`}
              transition={{ type: "spring", stiffness: 500, damping: 40 }}
              className="absolute inset-0 rounded-[5px] bg-accent"
            />
          )}
          <span className="relative">{label}</span>
        </button>
      ))}
    </div>
  );
}

/** The page's hairline header: the title, the owner switch, the board and list switch on the jobs page, and the page's actions. */
export function PanelHeader({
  title,
  ownerView,
  jobView,
  actions,
}: {
  title: string;
  ownerView?: SwitchProps<OwnerView>;
  jobView?: { current: JobView; onChange: (view: JobView) => void };
  actions?: ReactNode;
}) {
  return (
    <header className="flex h-11 shrink-0 items-center gap-2 border-b px-2 md:px-3">
      <h1 className="min-w-0 flex-1 truncate ps-2 font-medium">{title}</h1>
      {ownerView && <ViewSwitch {...ownerView} />}
      {jobView && <ViewSwitch label="Layout" options={JOB_VIEWS} {...jobView} />}
      {actions}
    </header>
  );
}

/** One key and what it does, for the footer's hints. */
export type KeyHint = { keys: readonly string[]; label: string };

/** The page's hairline footer: a summary on the left, then how fresh the data is and the page's keys. */
export function PanelFooter({ status, note, summary, keys = [] }: { status: FeedStatus; note?: string; summary?: ReactNode; keys?: readonly KeyHint[] }) {
  return (
    <footer className="flex h-10 shrink-0 items-center gap-3 border-t px-4 text-xs text-muted-foreground md:px-5">
      {summary && <span className="min-w-0 truncate tabular-nums">{summary}</span>}
      <span className="ms-auto flex shrink-0 items-center gap-1.5">
        <span className={cn("size-1.5 shrink-0 rounded-full", STATUS[status].dot)} />
        {STATUS[status].label}
        {note && ` · ${note}`}
      </span>
      <span className="hidden items-center gap-3 lg:flex">
        {[...keys, { keys: ["["], label: "sidebar" }].map(({ keys: combo, label }) => (
          <span key={label} className="flex items-center gap-1">
            {combo.map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
            {label}
          </span>
        ))}
      </span>
    </footer>
  );
}
