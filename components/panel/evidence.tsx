"use client";

import { CheckIcon, ShieldCheckIcon, ShieldAlertIcon, XIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import type { JobEvidenceRow, JobRow } from "@/db/schema";
import { parseAssessment } from "@/lib/assessment";
import {
  CHECK_NAME_LABELS,
  formatDuration,
  parseSummary,
  CHECK_SOURCE_LABELS,
  PRODUCER_LABELS,
  shortSha,
  type EvidenceCheck,
  type EvidenceLine as Line,
  type EvidenceSummary,
} from "@/lib/evidence";
import { mediaKind, mediaUrl } from "@/lib/media";
import { cn } from "@/lib/utils";
import { jobEvidenceLine, shownDecision } from "./cards";
import { useFeed, type Feed } from "./live-refresh";
import { Time } from "./time";

const TONE: Record<Line["tone"], string> = {
  success: "text-success",
  destructive: "text-destructive",
  warning: "text-warning",
  muted: "text-muted-foreground",
};

/** The one line a card shows apart from its stage: verified at which commit, or not at the head. */
export function EvidenceLine({ line, className }: { line: Line; className?: string }) {
  const Icon = line.tone === "success" ? ShieldCheckIcon : ShieldAlertIcon;
  return (
    <p className={cn("flex items-center gap-1 text-xs", TONE[line.tone], className)}>
      <Icon className="size-3 shrink-0" />
      <span className="truncate">{line.text}</span>
    </p>
  );
}

type CheckRow = Pick<EvidenceCheck, "name" | "passed" | "exitCode" | "durationMs"> & Partial<Pick<EvidenceCheck, "command" | "outputTail">>;

function CheckItem({ check }: { check: CheckRow }) {
  const meta = [formatDuration(check.durationMs), !check.passed && (check.exitCode === null ? "no exit code" : `exit ${check.exitCode}`)]
    .filter(Boolean)
    .join(" · ");
  const head = (
    <div className="flex min-w-0 items-baseline gap-2">
      {check.passed ? (
        <CheckIcon className="size-3.5 shrink-0 self-center text-success" />
      ) : (
        <XIcon className="size-3.5 shrink-0 self-center text-destructive" />
      )}
      <span className="font-medium">{CHECK_NAME_LABELS[check.name]}</span>
      {check.command && <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{check.command}</span>}
      <span className="ml-auto shrink-0 text-xs text-faint tabular-nums">{meta}</span>
    </div>
  );
  if (!check.outputTail) return <li>{head}</li>;
  return (
    <li>
      <details open={!check.passed} className="group">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">{head}</summary>
        <pre className="mt-1 max-h-64 overflow-auto rounded-md border bg-muted/40 p-2 font-mono text-xs whitespace-pre-wrap text-muted-foreground">
          {check.outputTail}
        </pre>
      </details>
    </li>
  );
}

function provenance(row: { producer: EvidenceSummary["producer"]; source: EvidenceSummary["source"]; clean: boolean }) {
  return [
    `Run by ${PRODUCER_LABELS[row.producer]}`,
    CHECK_SOURCE_LABELS[row.source],
    !row.clean && "uncommitted changes, so it proves nothing about the commit",
  ]
    .filter(Boolean)
    .join(" · ");
}

/** Which side of a before/after pair a media file is, from its name (`before-…`, `after-…`); never from its caption. */
export const mediaPhase = (file: string) => /^(before|after)-/.exec(file)?.[1] ?? null;

/** Run detail's evidence: what the agent showed, then the checks at the PR head, then every earlier commit. Media shows; the checks prove. */
export function EvidenceSection({ feed, job }: { feed: Feed<JobEvidenceRow>; job: JobRow }) {
  const { rows } = useFeed(feed);
  const line = jobEvidenceLine(job);
  const head = shownDecision(job)?.headSha ?? null;
  const media = parseAssessment(job.merge_assessment)?.media ?? [];
  const attemptRows = rows.filter((r) => r.attempt === job.attempt);
  if (!line && attemptRows.length === 0 && media.length === 0) return null;
  // The PR head's checks lead; the rest follow newest first, as the feed has them.
  const ordered = [...attemptRows].sort((x, y) => Number(y.sha === head) - Number(x.sha === head));
  return (
    <section aria-label="Evidence" className="flex flex-col gap-2.5 px-4.5 py-3.5 text-sm">
      <h3 className="flex items-baseline justify-between gap-2 text-sm font-medium text-muted-foreground">
        Evidence
        {job.pr_url && <span className="text-xs font-normal text-muted-foreground">attached to the PR</span>}
      </h3>
      {media.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <h4 className="text-xs font-medium text-muted-foreground">Media</h4>
          <div className="grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2">
            {media.map((m, i) => {
              const src = mediaUrl(job.key, i, job.assessment_event_id);
              const phase = mediaPhase(m.file);
              return (
                <figure key={`${i}:${m.file}`} className="flex min-w-0 flex-col gap-1">
                  {mediaKind(m.file) === "video" ? (
                    <video src={src} controls preload="metadata" className="aspect-video w-full rounded-md border bg-muted" />
                  ) : (
                    <a href={src} target="_blank" rel="noreferrer" className="block overflow-hidden rounded-md border bg-muted">
                      {/* An owner-only image behind the session; next/image would fetch it without the cookie. */}
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={src} alt={m.caption} loading="lazy" className="aspect-video w-full object-cover object-top" />
                    </a>
                  )}
                  <figcaption className="flex items-start gap-1.5 text-xs text-muted-foreground">
                    {phase && <Badge variant={phase === "before" ? "error" : "success"}>{phase === "before" ? "Before" : "After"}</Badge>}
                    {m.caption}
                  </figcaption>
                </figure>
              );
            })}
          </div>
        </div>
      )}
      {line && <EvidenceLine line={line} className="text-sm" />}
      {attemptRows.length === 0 && <p className="text-muted-foreground">No checks were reported for this attempt yet.</p>}
      {ordered.length > 0 && (
        <ol className="flex flex-col gap-3">
          <CommitRow row={ordered[0]} head={head} first />
        </ol>
      )}
      {ordered.length > 1 && (
        <details className="text-xs">
          <summary className="cursor-pointer text-muted-foreground">Earlier commits · {ordered.length - 1}</summary>
          <ol className="mt-2 flex flex-col gap-3">
            {ordered.slice(1).map((row) => (
              <CommitRow key={row.sha} row={row} head={head} />
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

function CommitRow({ row, head, first }: { row: JobEvidenceRow; head: string | null; first?: boolean }) {
  return (
    <li className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-mono text-xs">
          {first ? `factory-verify · ${shortSha(row.sha)} · ${row.clean ? "clean tree" : "uncommitted changes"}` : shortSha(row.sha)}
        </span>
        {head === row.sha && <span className="text-xs text-muted-foreground">PR head</span>}
        <span className="ml-auto text-xs text-faint">
          <Time date={row.recorded_at} />
        </span>
      </div>
      <p className={cn("text-xs", row.clean ? "text-muted-foreground" : "text-warning")}>{provenance(row)}</p>
      <ul className="flex flex-col gap-1">
        {row.checks.map((check, i) => (
          <CheckItem key={`${check.name}-${i}`} check={check} />
        ))}
      </ul>
    </li>
  );
}

/** The inbox's evidence: the latest commit's checks, without output, held against the PR head. */
export function EvidenceSummaryList({ job }: { job: JobRow }) {
  const line = jobEvidenceLine(job);
  const summary = parseSummary(job.evidence);
  const current = summary?.attempt === job.attempt ? summary : null;
  if (!line) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <EvidenceLine line={line} className="text-sm" />
      {current && (
        <>
          <p className="text-xs text-muted-foreground">
            {provenance(current)} · at <span className="font-mono">{shortSha(current.sha)}</span> <Time date={new Date(current.at)} />
          </p>
          <ul className="flex flex-col gap-1">
            {current.checks.map((check, i) => (
              <CheckItem key={`${check.name}-${i}`} check={check} />
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
