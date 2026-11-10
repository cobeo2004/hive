import type { MeterAccount } from "@/lib/account-meters";
import { cn } from "@/lib/utils";
import { ShortTime } from "./time";

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

function Window({ label, pct }: { label: string; pct: number | null }) {
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs">
        <span className="text-muted-foreground">{label}</span>
        <span className="tabular-nums">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
      </div>
      <MeterBar pct={pct} label={label} />
    </div>
  );
}

/** One account's usage: the 5-hour window, the weekly window and when the 5-hour one resets. */
export function UsageMeter({ account }: { account: MeterAccount }) {
  const { label, kind, fiveHour, weekly } = account;
  return (
    <div className="space-y-2">
      <div className="text-sm font-medium">{label}</div>
      {kind === "api_key" ? (
        <div className="text-xs text-muted-foreground">API key</div>
      ) : (
        <>
          <Window label="5-hour window" pct={fiveHour?.usedPct ?? null} />
          <Window label="Weekly" pct={weekly?.usedPct ?? null} />
          {fiveHour?.resetsAt && (
            <div className="text-xs text-faint">
              Resets <ShortTime date={fiveHour.resetsAt} />
            </div>
          )}
        </>
      )}
    </div>
  );
}
