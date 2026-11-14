"use client";

import { ChevronRightIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useMemo } from "react";
import type { JobRow } from "@/db/schema";
import type { Viewer } from "@/lib/inbox";
import { cn } from "@/lib/utils";
import { jobsHref } from "./job-view";
import { type Feed, useFeed } from "./live-refresh";
import { elapsed, harnessChip, isCurrent, repoBadge, settledJobs, waitingJobs, wikiHref, workflowHref, workingJobs } from "./shell-model";
import { useNow } from "./time";

const SECTION = "flex items-center justify-between px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground";
/** Each dropdown lists this many; the Jobs and Inbox pages list the rest. */
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

/** A count that opens in place to its first jobs. */
function JobsDropdown({ label, jobs, empty, now }: { label: string; jobs: JobRow[]; empty: string; now: number | null }) {
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
      <JobsDropdown label="Waiting on you" jobs={waiting} empty="Nothing waiting" now={now} />
      <JobsDropdown label="Settled" jobs={settled} empty="Nothing settled" now={now} />
    </div>
  );
}

/** The registered repos over the jobs, each opening in place to its Workflow and Wiki pages. */
export function SidebarRepos({ repos }: { repos: string[] }) {
  const pathname = usePathname();
  return (
    <div className="mb-1 flex flex-col gap-0.5 border-b pb-2">
      <Link
        href="/repositories"
        aria-current={pathname === "/repositories" ? "page" : undefined}
        className={`${SECTION} rounded-md outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:text-foreground`}
      >
        <span>Repositories</span>
        <span>Manage ›</span>
      </Link>
      {repos.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">No repositories yet</p>}
      {repos.map((repo) => {
        const { mark, tone } = repoBadge(repo);
        const links = [
          { label: "Workflow", href: workflowHref(repo) },
          { label: "Wiki", href: wikiHref(repo) },
        ];
        return (
          // Opens on its own while one of its pages is shown.
          <details key={repo} className="group" open={links.some((l) => isCurrent(l.href, pathname)) || undefined}>
            <summary className="flex h-8 cursor-pointer list-none items-center gap-1.5 rounded-lg px-2.5 text-xs text-muted-foreground outline-none hover:bg-accent/60 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring [&::-webkit-details-marker]:hidden">
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 transition-transform duration-200 ease-out group-open:rotate-90" />
              <span className={`inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[9px] font-bold ${tone}`}>{mark}</span>
              <span className="min-w-0 truncate">{repo}</span>
            </summary>
            {links.map(({ label, href }) => {
              const on = isCurrent(href, pathname);
              return (
                <Link
                  key={label}
                  href={href}
                  aria-current={on ? "page" : undefined}
                  className={cn(
                    "flex h-7 items-center rounded-md ps-[42px] pe-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
                    on ? "bg-primary/10 font-semibold text-foreground" : "text-muted-foreground hover:bg-accent/60 hover:text-foreground",
                  )}
                >
                  {label}
                </Link>
              );
            })}
          </details>
        );
      })}
    </div>
  );
}
