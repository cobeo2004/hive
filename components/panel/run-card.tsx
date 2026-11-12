import { CloudIcon, ExternalLinkIcon, MonitorIcon } from "lucide-react";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ui/spinner";
import type { AgentRow, RunRow } from "@/db/schema";
import type { SandboxState } from "@/lib/execution";
import type { Tracking } from "@/lib/harness";
import type { MergeDecision } from "@/lib/merge-decision";
import { activityHref } from "@/lib/run-links";
import { stopLine, type StopView } from "@/lib/stop";
import { cn } from "@/lib/utils";
import { showsDecision, whereLine, type BoardCard } from "./cards";
import { EvidenceLine } from "./evidence";
import { formatUsd, runCost, runTitle, shortId } from "./format";
import { jobsHref } from "./job-view";
import { useOwnerParam } from "./use-owner-param";
import { decisionLine } from "./merge-decision";
import { ModelChip } from "./model-chip";
import { Time } from "./time";

const cardClass = (selected: boolean) =>
  cn(
    "relative grid gap-2 rounded-2xl border-[1.5px] bg-background p-3 text-left text-sm shadow-xs transition-colors hover:border-(--border-strong) dark:shadow-none",
    selected && "border-primary ring-3 ring-(--primary-soft)",
  );

/** Lime marks a job at `pr` with every check green, and nothing else. */
export const isPrReady = (card: Pick<BoardCard, "stage" | "evidence">) => card.stage === "pr" && card.evidence?.tone === "success";

/** `#1309` for a GitHub pull URL, null for anything else. */
export function prNumber(url: string | null) {
  if (!url || !URL.canParse(url)) return null;
  const segments = new URL(url).pathname.split("/");
  const at = segments.indexOf("pull");
  const n = at < 0 ? "" : (segments[at + 1] ?? "");
  return n !== "" && [...n].every((c) => c >= "0" && c <= "9") ? `#${n}` : null;
}

/** `hive-sandbox #1` for a GitHub issue, `UNI-142` for a Linear one, else the job key: the ticket, not the factory's internal key. */
export function issueRef(card: Pick<BoardCard, "sourceLink" | "jobKey" | "id">) {
  const href = card.sourceLink?.href;
  if (href && URL.canParse(href)) {
    const url = new URL(href);
    const [owner, repo, kind, n] = url.pathname.split("/").filter(Boolean);
    if (url.hostname === "github.com" && owner && repo && kind === "issues" && n) return `${repo} #${n}`;
    if (url.hostname === "linear.app" && repo === "issue" && kind) return kind;
  }
  return card.jobKey ?? card.id.slice(0, 8);
}

/** `45s`, `12m`, `2h 5m`: how long the attempt has been going, for the card's footer. */
export function shortDuration(ms: number) {
  const m = Math.floor(ms / 60_000);
  if (m < 1) return `${Math.max(0, Math.round(ms / 1000))}s`;
  return m < 60 ? `${m}m` : `${Math.floor(m / 60)}h ${m % 60}m`;
}

/** From the attempt's first run starting to its last event. */
const attemptSpan = (runs: readonly RunRow[]) =>
  runs.length === 0 ? null : Math.max(...runs.map((r) => r.last_event_at.getTime())) - Math.min(...runs.map((r) => r.started_at.getTime()));

/** What the given runs cost, their subagents included. */
const attemptCost = (runs: readonly RunRow[], agents: readonly AgentRow[]) =>
  runs.reduce(
    (sum, run) =>
      sum +
      runCost(
        run,
        agents.filter((a) => a.session_id === run.session_id),
      ),
    0,
  );

function AgentsAndCost({
  runs,
  agents,
  allRuns,
}: {
  runs: readonly RunRow[];
  agents: readonly AgentRow[];
  /** Every attempt's runs, when they differ from the current attempt's. */
  allRuns?: readonly RunRow[];
}) {
  const running = agents.filter((a) => a.status === "running").length;
  const costOf = (list: readonly RunRow[]) => attemptCost(list, agents);
  const cost = costOf(runs);
  const total = allRuns && allRuns.length !== runs.length ? costOf(allRuns) : undefined;
  return (
    <>
      {agents.length > 0 && <span>{running > 0 ? `${running}/${agents.length}` : agents.length} agents</span>}
      <span className="font-mono" title={total !== undefined ? "spend of this attempt" : undefined}>
        {formatUsd(cost)}
      </span>
      {total !== undefined && <span className="font-mono text-faint">all attempts {formatUsd(total)}</span>}
    </>
  );
}

const TRACKING_HINT: Record<Tracking, string | undefined> = {
  full: undefined,
  stages: "The runner reads this harness's cost from its session logs; it shows once usage is read and the model has a price.",
  none: "This harness reports no stages, agents or cost; check the run in T3.",
};

const SANDBOX_HINT: Record<SandboxState, string> = {
  running: "Runs in its own cloud sandbox",
  hibernated: "The sandbox is snapshotted while the job waits; it wakes when the job needs it",
};

/** Where a sandboxed job's sandbox is: running, or hibernated as a snapshot. `bare` drops the word sandbox for a line that says it already. */
export function SandboxBadge({ state, bare = false }: { state: SandboxState; bare?: boolean }) {
  return (
    <Badge variant="outline" className="gap-1.5 rounded-md font-normal text-muted-foreground" title={SANDBOX_HINT[state]}>
      <span className={cn("size-1.5 rounded-full", state === "running" ? "bg-success" : "bg-muted-foreground/50")} />
      {bare ? state : `Sandbox · ${state}`}
    </Badge>
  );
}

function MergeLine({ decision }: { decision: MergeDecision | null }) {
  const line = decisionLine(decision);
  return (
    <p className={cn("line-clamp-2 text-xs", line.tone)}>
      {line.text}
      {line.link && (
        <>
          {" · "}
          <a href={line.link.href} target="_blank" rel="noreferrer" className="relative underline underline-offset-2">
            {line.link.label}
          </a>
        </>
      )}
    </p>
  );
}

const STOP_TONE: Record<StopView["kind"], string> = {
  stopping: "text-warning",
  confirmed: "text-muted-foreground",
  unconfirmed: "text-destructive",
};

/** Where the job's stop is; an unconfirmed one links to its thread in T3 when the card knows the link. */
function StopLine({ view, t3Href }: { view: StopView; t3Href?: string }) {
  return (
    <p
      className={cn("flex flex-wrap items-center gap-x-1.5 text-xs", STOP_TONE[view.kind])}
      title={view.kind === "stopping" ? undefined : view.kind === "confirmed" ? view.evidence : view.reason}
    >
      {view.kind === "stopping" && <Spinner className="size-2.5" />}
      {stopLine(view)}
      {view.kind === "unconfirmed" && t3Href && (
        <a href={t3Href} className="relative inline-flex items-center gap-0.5 underline underline-offset-2">
          Open in T3
          <ExternalLinkIcon className="size-3" />
        </a>
      )}
    </p>
  );
}

export function StageCard({
  card,
  agents,
  selected,
  machineName,
  repoLabel,
  t3Href,
}: {
  card: BoardCard;
  agents: readonly AgentRow[];
  selected: boolean;
  machineName: string | null;
  /** Shown only while more than one repo has jobs. */
  repoLabel?: string;
  /** The job's thread in its machine's T3, for a stop that couldn't be confirmed. */
  t3Href?: string;
}) {
  const owner = useOwnerParam();
  const { latest } = card;
  const where = card.runsOn && whereLine(card.runsOn, machineName);
  const sandbox = card.runsOn?.kind === "modal" ? card.runsOn.sandbox : null;
  const pr = prNumber(card.prUrl);
  const ref = issueRef(card);
  const span = attemptSpan(card.attemptRuns);
  const status = showsDecision(card) || card.evidence || card.stop || card.nudgedAt;
  return (
    <div data-card={card.id} className={cardClass(selected)}>
      {latest && (
        <Link
          href={jobsHref("board", latest.session_id, false, owner)}
          scroll={false}
          aria-label={`Open ${card.jobKey ?? card.title}`}
          className="absolute inset-0 rounded-2xl"
        />
      )}
      <div className="flex items-center justify-between gap-2">
        <span className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-muted-foreground" title={card.jobKey ?? undefined}>
          {latest?.status === "active" && <Spinner className="size-2.5 shrink-0" aria-label="Working" />}
          {card.sourceLink ? (
            <a href={card.sourceLink.href} target="_blank" rel="noreferrer" className="relative truncate underline-offset-2 hover:underline">
              {ref}
            </a>
          ) : (
            <span className="truncate">{ref}</span>
          )}
        </span>
        <span className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
          {isPrReady(card) && <span className="rounded-full bg-(--lime) px-2 text-[11.5px] font-medium text-(--on-lime)">PR ready</span>}
          {pr && card.prUrl && (
            <a href={card.prUrl} target="_blank" rel="noreferrer" className="relative inline-flex items-center gap-0.5 underline-offset-2 hover:underline">
              PR {pr}
              <ExternalLinkIcon className="size-3" />
            </a>
          )}
        </span>
      </div>
      <div className="line-clamp-2 text-[13.5px] leading-[19px] font-medium text-pretty">{card.title}</div>
      {card.stage === "waiting" && card.question ? (
        <p className="line-clamp-2 text-xs leading-[17px] text-warning">{card.question}</p>
      ) : (
        card.summary && <p className="line-clamp-2 text-xs leading-[17px] text-(--ink-2)">{card.summary}</p>
      )}
      {status && (
        <div className="grid gap-1 border-t border-dashed pt-2">
          {card.evidence && <EvidenceLine line={card.evidence} />}
          {showsDecision(card) && <MergeLine decision={card.mergeDecision} />}
          {card.stop && <StopLine view={card.stop.view} t3Href={t3Href} />}
          {card.nudgedAt && (
            <p className="text-xs text-warning">
              Stuck · nudged <Time date={card.nudgedAt} />
            </p>
          )}
        </div>
      )}
      <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <ModelChip model={latest?.model ?? null} />
        {repoLabel && <span className="min-w-0 truncate">{repoLabel}</span>}
        <span className="ms-auto flex shrink-0 items-center gap-2">
          {where && (
            <span title={sandbox ? `${where} · ${sandbox}` : where} className="flex items-center gap-1">
              {card.runsOn?.kind === "modal" ? <CloudIcon className="size-3.5" aria-hidden /> : <MonitorIcon className="size-3.5" aria-hidden />}
              {card.runsOn?.kind === "modal" ? "cloud" : "local"}
              {sandbox === "hibernated" && <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-label="hibernated" />}
            </span>
          )}
          {card.attempt > 1 && <span>attempt {card.attempt}</span>}
          {!card.harness || card.harness.tracking === "full" ? (
            <span className="font-mono" title="Spend of this attempt">
              {formatUsd(attemptCost(card.attemptRuns, agents))}
            </span>
          ) : (
            <span title={TRACKING_HINT[card.harness.tracking]}>{card.harness.tracking === "stages" ? "cost unknown" : "not tracked"}</span>
          )}
          {span !== null && (
            <span className="font-mono" title="From the attempt's start to its latest event">
              {shortDuration(span)}
            </span>
          )}
        </span>
      </div>
    </div>
  );
}

export function RunCard({ run, agents, selected }: { run: RunRow; agents: readonly AgentRow[]; selected: boolean }) {
  return (
    <Link href={activityHref(run.session_id)} scroll={false} className={cn(cardClass(selected), run.status === "ended" && "opacity-60")}>
      <div className="flex items-center gap-1.5 font-mono text-xs text-faint">
        {run.status === "active" && <Spinner className="size-2.5" />}
        {run.job_key ?? shortId(run.session_id)}
      </div>
      <div className="line-clamp-2 font-medium">{runTitle(run)}</div>
      <div className="flex flex-wrap items-center gap-1.5 text-xs text-muted-foreground">
        <Badge variant="outline" className="rounded-md font-normal">
          {run.status}
        </Badge>
        <ModelChip model={run.model} />
        <AgentsAndCost runs={[run]} agents={agents} />
      </div>
      {run.repo && (
        <div className="truncate font-mono text-xs text-faint">
          {run.repo}
          {run.branch ? ` · ${run.branch}` : ""}
        </div>
      )}
    </Link>
  );
}
