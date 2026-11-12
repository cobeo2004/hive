import { cn } from "@/lib/utils";

/** A thin usage bar; an empty track when there is no reading. */
export function MeterBar({ pct, label, className }: { pct: number | null; label: string; className?: string }) {
  const used = pct === null ? null : Math.min(100, Math.max(0, pct));
  return (
    <div
      className={cn("h-1 overflow-hidden rounded-full bg-muted", className)}
      {...(used === null ? {} : { role: "progressbar", "aria-label": label, "aria-valuenow": Math.round(used), "aria-valuemin": 0, "aria-valuemax": 100 })}
    >
      {used !== null && <div className={cn("h-full rounded-full", used >= 90 ? "bg-warning" : "bg-primary")} style={{ width: `${used}%` }} />}
    </div>
  );
}
