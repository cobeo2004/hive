"use client";

import { ArchiveIcon, InboxIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { startTransition, Suspense, use, useMemo, useOptimistic, useSyncExternalStore, type ComponentProps } from "react";
import { Button } from "@/components/ui/button";
import type { AgentRow, AuditRow, EventRow, JobEvidenceRow, JobRow, MachineRow, RepoSettingsRow, RunRow } from "@/db/schema";
import { Board } from "./board";
import { panelCards } from "./cards";
import { splitArchived } from "@/lib/archive";
import { sandboxState } from "@/lib/execution";
import { attemptBranch } from "@/lib/factory";
import { inboxItems, ownedBy, parseOwnerView, type OwnerView, type Viewer } from "@/lib/inbox";
import { reportedHarnesses } from "@/lib/machine";
import { cn } from "@/lib/utils";
import { groupBy, spendOf } from "./format";
import { Inbox } from "./inbox";
import { FullViewToggle, useEscapeToSidePanel, useFullView } from "./full-view";
import { JobList } from "./job-list";
import { inboxHref, JOB_VIEW_COOKIE, jobsHref, type JobView } from "./job-view";
import { NewJobButton } from "./new-job-button";
import { OtherActivity } from "./other-activity";
import { RunDetail } from "./run-detail";
import { RunDetailSkeleton } from "./skeletons";
import { useFeed, type Feed } from "./live-refresh";
import { PanelFooter, PanelHeader, type KeyHint } from "./panel-header";
import { RepoSelect, repoOptions, useRepoFilter, useRepoLabels } from "./repo-filter";
import { StatsStrip } from "./stats-strip";
import { useAfterHydration } from "./time";

export type DetailProps = {
  sessionId: string;
  agents: Feed<AgentRow>;
  events: Feed<EventRow>;
  stages: Feed<EventRow>;
  /** Present when the run belongs to a job. */
  audit: Feed<AuditRow> | undefined;
  /** The job's evidence per commit; present when the run belongs to a job. */
  evidence: Feed<JobEvidenceRow> | undefined;
};

/** The open run: its id right away, its feeds once they load. */
export type OpenRun = { sessionId: string; data: Promise<DetailProps> };

type LoadedDetailProps = Omit<ComponentProps<typeof RunDetail>, "agents" | "events" | "stages" | "audit" | "evidence"> & {
  data: Promise<DetailProps>;
};

/** Suspends until the run's feeds arrive, so the page around it never waits for them. */
function LoadedRunDetail({ data, ...props }: LoadedDetailProps) {
  const { agents, events, stages, audit, evidence } = use(data);
  return <RunDetail {...props} agents={agents} events={events} stages={stages} audit={audit} evidence={evidence} />;
}

export type PanelView = "inbox" | "jobs" | "activity";

/** What the jobs page and the inbox need of each registered repo. */
export type PanelRepo = Pick<RepoSettingsRow, "repo" | "display_name" | "enabled" | "is_default">;

const LIST_KEYS: readonly KeyHint[] = [
  { keys: ["J", "K"], label: "move" },
  { keys: ["↵"], label: "open" },
  { keys: ["Esc"], label: "close" },
];

const FULL_VIEW_KEYS: readonly KeyHint[] = [{ keys: ["Esc"], label: "side panel" }];

function viewMeta(view: PanelView) {
  switch (view) {
    case "inbox":
      return { title: "Inbox", job: false };
    case "jobs":
      return { title: "Jobs", job: true };
    case "activity":
      return { title: "Other activity", job: false };
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function footerSummary(view: PanelView, counts: { jobs: number; sessions: number; inbox: number }) {
  switch (view) {
    case "inbox":
      return counts.inbox === 0 ? "Nothing waiting" : `${plural(counts.inbox, "item", "items")} waiting on you`;
    case "jobs":
      return plural(counts.jobs, "job", "jobs");
    case "activity":
      return plural(counts.sessions, "session", "sessions");
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

/** Where closing the run detail goes: the same page, in the same layout. */
function closeHref(view: PanelView, jobView: JobView, archived: boolean, owner: OwnerView) {
  switch (view) {
    case "inbox":
      return inboxHref(owner);
    case "jobs":
      return jobsHref(jobView, undefined, archived, owner);
    case "activity":
      return "/activity";
    default: {
      const never: never = view;
      throw new Error(`unknown view ${String(never)}`);
    }
  }
}

const WIDE = "(min-width: 64rem)";

/** Whether the page is at Tailwind's lg or wider; the server assumes it is. */
function useWide() {
  return useSyncExternalStore(
    (notify) => {
      window.addEventListener("resize", notify);
      return () => window.removeEventListener("resize", notify);
    },
    () => window.matchMedia(WIDE).matches,
    () => true,
  );
}

/** The jobs page's board or list. Switching keeps the page mounted, so the live feeds stay subscribed. */
function useJobView(current: JobView) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [jobView, setOptimistic] = useOptimistic(current);
  const switchTo = (next: JobView) => {
    document.cookie = `${JOB_VIEW_COOKIE}=${next}; path=/; max-age=${60 * 60 * 24 * 365}`;
    const params = new URLSearchParams(searchParams);
    // `view` may hold the owner alias; keep it as `owner` before the layout takes `view`.
    const alias = parseOwnerView(params.get("view"));
    if (alias) params.set("owner", params.get("owner") ?? alias);
    params.set("view", next);
    startTransition(() => {
      setOptimistic(next);
      router.replace(`/?${params}`, { scroll: false });
    });
  };
  return [jobView, switchTo] as const;
}

/** Mine or Everyone. Lives only in the URL, so no cookie; `view` is dropped when it held the alias. */
function useOwnerView(current: OwnerView) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [owner, setOptimistic] = useOptimistic(current);
  const switchTo = (next: OwnerView) => {
    const params = new URLSearchParams(searchParams);
    params.set("owner", next);
    if (parseOwnerView(params.get("view"))) params.delete("view");
    startTransition(() => {
      setOptimistic(next);
      router.replace(`${pathname}?${params}`, { scroll: false });
    });
  };
  return [owner, switchTo] as const;
}

const JOBS_OWNER_OPTIONS: readonly { value: OwnerView; label: string }[] = [
  { value: "everyone", label: "Everyone" },
  { value: "mine", label: "Mine" },
];

export function LivePanel({
  view,
  jobView: currentJobView,
  owner: currentOwner,
  me,
  repo: currentRepo,
  archived,
  registry,
  jobs,
  runs,
  agents,
  machines,
  detail,
  inboxKey,
}: {
  view: PanelView;
  /** The jobs page's layout, from ?view or the remembered one. */
  jobView: JobView;
  /** Mine or Everyone, from ?owner or the page's default. */
  owner: OwnerView;
  /** Who is looking, for Mine; null when signed out. */
  me: Viewer | null;
  /** The repo the jobs page and the inbox show, from ?repo or the remembered one; null shows all. */
  repo: string | null;
  /** The jobs page shows the archive, from ?archived=1. */
  archived: boolean;
  registry: readonly PanelRepo[];
  /** The inbox item open on the right, by job key. */
  inboxKey: string | undefined;
  jobs: Feed<JobRow>;
  runs: Feed<RunRow>;
  agents: Feed<AgentRow>;
  machines: Feed<MachineRow>;
  detail: OpenRun | undefined;
}) {
  const { rows: jobRows } = useFeed(jobs);
  const { rows: runRows, status } = useFeed(runs);
  const { rows: agentRows } = useFeed(agents);
  const { rows: machineRows } = useFeed(machines);
  const machineById = useMemo(() => new Map(machineRows.map((m) => [m.id, m])), [machineRows]);

  const agentsBySession = useMemo(() => groupBy(agentRows, (a) => a.session_id), [agentRows]);
  const harnesses = useMemo(() => reportedHarnesses(machineRows, 0) ?? [], [machineRows]);
  const enabledHarnesses = useMemo(() => harnesses.filter((h) => h.enabled), [harnesses]);
  // Archived jobs leave the board, the list, the inbox and their counts.
  const { shown: liveJobs, archived: archivedJobs } = useMemo(() => splitArchived(jobRows), [jobRows]);
  const { live: liveCards, archived: archivedCards } = useMemo(() => panelCards(jobRows, runRows, harnesses), [jobRows, runRows, harnesses]);
  const showArchive = view === "jobs" && archived;
  const cards = showArchive ? archivedCards : liveCards;
  const unstaged = useMemo(() => {
    const claimed = new Set(jobRows.map((j) => j.key));
    return runRows.filter((r) => r.stage === null && !(r.job_key && claimed.has(r.job_key)));
  }, [jobRows, runRows]);
  const sandboxNote = useMemo(() => {
    const states = jobRows.map(sandboxState);
    const running = states.filter((s) => s === "running").length;
    const hibernated = states.filter((s) => s === "hibernated").length;
    if (running + hibernated === 0) return null;
    return `${running} in sandboxes${hibernated > 0 ? `, ${hibernated} hibernated` : ""}`;
  }, [jobRows]);
  const startOfToday = useAfterHydration(() => new Date().setHours(0, 0, 0, 0), 0);
  const selectedRun = detail && runRows.find((r) => r.session_id === detail.sessionId);
  const selectedJob = selectedRun?.job_key ? jobRows.find((j) => j.key === selectedRun.job_key) : undefined;

  // Global, and Mine, because the "need you" button links to the inbox, which opens on Mine.
  const inboxCount = useMemo(() => inboxItems(ownedBy(liveJobs, "mine", me)).length, [liveJobs, me]);
  const fullView = useFullView();
  // Here rather than in RunDetail, so Esc leaves full view while the run is still loading too.
  useEscapeToSidePanel(selectedRun && detail ? fullView : { ...fullView, full: false });
  const [jobView, switchJobView] = useJobView(currentJobView);
  const [owner, switchOwner] = useOwnerView(currentOwner);

  // The filters apply to the loaded feeds; the "need you" count stays global.
  const options = useMemo(() => repoOptions(registry, showArchive ? archivedJobs : liveJobs), [registry, showArchive, archivedJobs, liveJobs]);
  const repoLabels = useRepoLabels(options);
  const [repoChoice, pickRepo] = useRepoFilter(currentRepo);
  const repo = options.some((o) => o.repo === repoChoice) ? repoChoice : null;
  const shownJobs = useMemo(() => (repo ? liveJobs.filter((j) => j.repo === repo) : liveJobs), [liveJobs, repo]);
  const mineIds = useMemo(() => new Set(ownedBy(jobRows, "mine", me).map((j) => j.id)), [jobRows, me]);
  const shownCards = useMemo(() => {
    const inRepo = repo ? cards.filter((c) => c.repo === repo) : cards;
    // The archive has no owner switch, so it lists every job.
    return owner === "mine" && !showArchive ? inRepo.filter((c) => c.jobId !== null && mineIds.has(c.jobId)) : inRepo;
  }, [cards, repo, owner, mineIds, showArchive]);
  const ownerJobs = useMemo(() => ownedBy(shownJobs, owner, me), [shownJobs, owner, me]);
  const mineCount = useMemo(() => inboxItems(ownedBy(shownJobs, "mine", me)).length, [shownJobs, me]);
  const everyoneCount = useMemo(() => inboxItems(shownJobs).length, [shownJobs]);
  const shownInbox = owner === "mine" ? mineCount : everyoneCount;
  const inboxOpen = useMemo(
    () => view === "inbox" && inboxKey !== undefined && inboxItems(ownerJobs).some((i) => i.job.key === inboxKey),
    [view, inboxKey, ownerJobs],
  );
  const runFull = fullView.full && selectedRun !== undefined;
  // Below lg an open run takes the whole width, so the list unmounts like in full view and its row keys stop.
  const wide = useWide();
  const runCovers = runFull || (selectedRun !== undefined && detail !== undefined && !wide);
  const repoSelect = options.length > 0 && <RepoSelect options={options} value={repo} onChange={pickRepo} />;

  const meta = viewMeta(view);
  const active = runRows.filter((r) => r.status === "active").length;
  const content = (() => {
    switch (view) {
      case "inbox":
        return <Inbox jobs={ownerJobs} cards={cards} selected={inboxKey} repoLabels={repoLabels} fullView={fullView} />;
      case "jobs":
        return showArchive ? (
          <JobList cards={shownCards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} repoLabels={repoLabels} archived />
        ) : jobView === "board" ? (
          <Board cards={shownCards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} repoLabels={repoLabels} />
        ) : (
          <JobList cards={shownCards} agentsBySession={agentsBySession} selected={detail?.sessionId} machines={machineById} repoLabels={repoLabels} />
        );
      case "activity":
        return <OtherActivity runs={unstaged} agentsBySession={agentsBySession} selected={detail?.sessionId} />;
      default: {
        const never: never = view;
        throw new Error(`unknown view ${String(never)}`);
      }
    }
  })();

  return (
    <>
      <PanelHeader
        title={showArchive ? "Archived jobs" : meta.title}
        ownerView={
          view === "jobs" && !showArchive
            ? { label: "Whose jobs", options: JOBS_OWNER_OPTIONS, current: owner, onChange: switchOwner }
            : view === "inbox"
              ? {
                  label: "Show",
                  options: [
                    { value: "mine", label: `Mine · ${mineCount}` },
                    { value: "everyone", label: `Everyone · ${everyoneCount}` },
                  ],
                  current: owner,
                  onChange: switchOwner,
                }
              : undefined
        }
        jobView={view === "jobs" && !showArchive ? { current: jobView, onChange: switchJobView } : undefined}
        actions={
          meta.job ? (
            <>
              {repoSelect}
              {(showArchive || archivedCards.length > 0) && (
                <Button
                  render={<Link href={jobsHref(jobView, undefined, !showArchive, owner)} scroll={false} />}
                  variant={showArchive ? "secondary" : "ghost"}
                  size="sm"
                  aria-pressed={showArchive}
                  className={showArchive ? undefined : "text-muted-foreground"}
                >
                  <ArchiveIcon data-icon="inline-start" />
                  Archived {archivedCards.length}
                </Button>
              )}
              {inboxCount > 0 && (
                <Button render={<Link href="/inbox" />} variant="ghost" size="sm" className="text-muted-foreground">
                  <InboxIcon data-icon="inline-start" />
                  {inboxCount} {inboxCount === 1 ? "needs" : "need"} you
                </Button>
              )}
              <NewJobButton harnesses={enabledHarnesses} repos={registry} />
            </>
          ) : view === "inbox" ? (
            repoSelect
          ) : undefined
        }
      />
      <div className="flex min-h-0 min-w-0 flex-1 flex-col">
        <StatsStrip runs={runRows} agentsBySession={agentsBySession} startOfToday={startOfToday} />
        <div className={cn("grid min-h-0 flex-1 grid-cols-1", selectedRun && !runFull && "lg:grid-cols-[minmax(0,1fr)_min(600px,46%)]")}>
          {/* Below lg an open run takes the whole width; closing it brings the page back. The class covers the first paint. */}
          {!runCovers && <div className={cn("contents", selectedRun && "max-lg:hidden")}>{content}</div>}
          {selectedRun && detail && (
            // Keyed by run, so opening another card shows the skeleton instead of holding the last run.
            <Suspense
              key={detail.sessionId}
              fallback={
                <RunDetailSkeleton
                  controls={
                    <>
                      <FullViewToggle {...fullView} />
                      <Button
                        render={<Link href={closeHref(view, jobView, showArchive, owner)} scroll={false} />}
                        variant="ghost"
                        size="icon-sm"
                        aria-label="Close run"
                      >
                        <XIcon />
                      </Button>
                    </>
                  }
                />
              }
            >
              <LoadedRunDetail
                data={detail.data}
                run={selectedRun}
                closeHref={closeHref(view, jobView, showArchive, owner)}
                fullView={fullView}
                job={selectedJob}
                machine={selectedJob?.machine_id ? machineById.get(selectedJob.machine_id) : undefined}
                harnesses={harnesses}
                jobSpend={
                  selectedJob
                    ? {
                        usd: spendOf(
                          runRows.filter((r) => r.branch === attemptBranch(selectedJob.key, selectedJob.attempt)),
                          agentsBySession,
                        ),
                        attempt: selectedJob.attempt,
                      }
                    : undefined
                }
              />
            </Suspense>
          )}
        </div>
      </div>
      <PanelFooter
        status={status}
        note={[`${active} active`, sandboxNote].filter(Boolean).join(" · ")}
        summary={
          showArchive
            ? plural(shownCards.length, "archived job", "archived jobs")
            : footerSummary(view, { jobs: shownCards.length, sessions: unstaged.length, inbox: shownInbox })
        }
        keys={
          fullView.full && (selectedRun || inboxOpen)
            ? FULL_VIEW_KEYS
            : (view === "jobs" && (jobView === "list" || showArchive)) || view === "inbox"
              ? LIST_KEYS
              : undefined
        }
      />
    </>
  );
}
