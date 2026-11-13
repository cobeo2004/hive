"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { useMemo } from "react";
import type { JobRow } from "@/db/schema";
import type { Viewer } from "@/lib/inbox";
import { inboxHref, jobsHref } from "./job-view";
import { type Feed, useFeed } from "./live-refresh";
import { elapsed, everyRepo, harnessChip, repoBadge, settledJobs, waitingJobs, workingJobs } from "./shell-model";
import { useNow } from "./time";

const SECTION = "flex items-center justify-between px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground";
/** Each dropdown lists this many; its View all link carries the rest. */
const CAP = 8;

/** One job with its repo, age since `since`, branch and harness; it opens the job's run like the board does. */
function JobLink({ job, since, now }: { job: JobRow; since: Date; now: number | null }) {
  const { name, mark, tone } = repoBadge(job.repo);
  const chip = harnessChip(job.provider);
  return (
    <Link
      href={jobsHref("list", job.session_id ?? undefined)}
      className="flex flex-col gap-0.5 rounded-[10px] px-2.5 py-2 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
    >
      <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className={`inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[9px] font-bold ${tone}`}>{mark}</span>
        <span className="min-w-0 truncate">{name}</span>
        <span className="ms-auto tabular-nums">{now === null ? "" : elapsed(now - since.getTime())}</span>
      </span>
      <span className="truncate text-[13.5px] font-medium text-foreground">{job.title}</span>
      <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
        <span className="min-w-0 truncate">hive/{job.key}</span>
        {chip && <span className="ms-auto shrink-0 rounded bg-(--surface-2) px-1 py-[3px] font-mono text-[9px] leading-none font-bold">{chip}</span>}
      </span>
    </Link>
  );
}

/** A count that opens in place to its first jobs, with a View all link to the page that lists every one. */
function JobsDropdown({ label, jobs, empty, viewAll, now }: { label: string; jobs: JobRow[]; empty: string; viewAll: string; now: number | null }) {
  return (
    <details className="group">
      <summary
        className={`${SECTION} cursor-pointer list-none rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden`}
      >
        <span className="flex items-center gap-1">
          <ChevronRightIcon aria-hidden className="size-3.5 transition-transform duration-200 ease-out group-open:rotate-90" />
          {label}
        </span>
        <span className="tabular-nums">{jobs.length}</span>
      </summary>
      {jobs.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">{empty}</p>}
      {jobs.slice(0, CAP).map((job) => (
        <JobLink key={job.id} job={job} since={job.stage_at ?? job.updated_at} now={now} />
      ))}
      <Link href={viewAll} className="block rounded-md px-2.5 py-1 text-xs text-muted-foreground hover:text-foreground">
        View all ›
      </Link>
    </details>
  );
}

/** The sidebar under the nav: the jobs at work, then Waiting on you and Settled, each opening in place to its jobs. */
export function SidebarJobs({ jobs, me }: { jobs: Feed<JobRow>; me: Viewer | null }) {
  const { rows } = useFeed(jobs);
  const working = useMemo(() => workingJobs(rows), [rows]);
  const waiting = useMemo(() => waitingJobs(rows, me), [rows, me]);
  const settled = useMemo(() => settledJobs(rows), [rows]);
  const now = useNow(30_000);
  return (
    <div className="flex flex-col gap-0.5">
      <div className={SECTION}>
        <span>Working</span>
        <span className="tabular-nums">{working.length}</span>
      </div>
      {working.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">Nothing running</p>}
      {working.map((job) => (
        <JobLink key={job.id} job={job} since={job.claimed_at} now={now} />
      ))}
      <JobsDropdown label="Waiting on you" jobs={waiting} empty="Nothing waiting" viewAll={everyRepo(inboxHref())} now={now} />
      <JobsDropdown label="Settled" jobs={settled} empty="Nothing settled" viewAll={everyRepo(jobsHref("list"))} now={now} />
    </div>
  );
}
