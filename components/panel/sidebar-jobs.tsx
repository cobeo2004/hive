"use client";

import Link from "next/link";
import { useMemo } from "react";
import type { JobRow } from "@/db/schema";
import type { Viewer } from "@/lib/inbox";
import { jobsHref } from "./job-view";
import { type Feed, useFeed } from "./live-refresh";
import { elapsed, harnessChip, repoBadge, sidebarCounts, workingJobs } from "./shell-model";
import { useNow } from "./time";

const SECTION = "flex items-center justify-between px-2.5 pt-2 pb-1 text-xs font-medium text-muted-foreground";

/** The sidebar under the nav: the jobs at work with their repo, age, branch and harness, then the Waiting on you and Settled counts. */
export function SidebarJobs({ jobs, me }: { jobs: Feed<JobRow>; me: Viewer | null }) {
  const { rows } = useFeed(jobs);
  const working = useMemo(() => workingJobs(rows), [rows]);
  const { waiting, settled } = useMemo(() => sidebarCounts(rows, me), [rows, me]);
  const now = useNow(30_000);
  return (
    <div className="flex flex-col gap-0.5">
      <div className={SECTION}>
        <span>Working</span>
        <span className="tabular-nums">{working.length}</span>
      </div>
      {working.length === 0 && <p className="px-2.5 py-1 text-xs text-muted-foreground">Nothing running</p>}
      {working.map((job) => {
        const { name, mark, tone } = repoBadge(job.repo);
        const chip = harnessChip(job.provider);
        return (
          <Link
            key={job.id}
            href={jobsHref("list", job.session_id ?? undefined)}
            className="flex flex-col gap-0.5 rounded-[10px] px-2.5 py-2 outline-none hover:bg-accent/60 focus-visible:ring-2 focus-visible:ring-ring"
          >
            <span className="flex items-center gap-1.5 text-xs text-muted-foreground">
              <span className={`inline-grid size-[18px] shrink-0 place-items-center rounded-[5px] text-[9px] font-bold ${tone}`}>{mark}</span>
              <span className="min-w-0 truncate">{name}</span>
              <span className="ms-auto tabular-nums">{now === null ? "" : elapsed(now - job.claimed_at.getTime())}</span>
            </span>
            <span className="truncate text-[13.5px] font-medium text-foreground">{job.title}</span>
            <span className="flex items-center gap-1.5 font-mono text-xs text-muted-foreground">
              <span className="min-w-0 truncate">hive/{job.key}</span>
              {chip && <span className="ms-auto shrink-0 rounded bg-(--surface-2) px-1 py-[3px] font-mono text-[9px] leading-none font-bold">{chip}</span>}
            </span>
          </Link>
        );
      })}
      <Link href="/inbox" className={`${SECTION} rounded-md hover:text-foreground`}>
        <span>Waiting on you</span>
        <span className="tabular-nums">{waiting} ›</span>
      </Link>
      <Link href="/" className={`${SECTION} rounded-md hover:text-foreground`}>
        <span>Settled</span>
        <span className="tabular-nums">{settled} ›</span>
      </Link>
    </div>
  );
}
