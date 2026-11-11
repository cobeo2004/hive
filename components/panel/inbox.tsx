"use client";

import { ExternalLinkIcon, XIcon } from "lucide-react";
import Link from "next/link";
import { Fragment, type ReactNode, useEffect, useMemo, useRef, useState } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import type { JobRow } from "@/db/schema";
import { parseAssessment } from "@/lib/assessment";
import { inboxItems, inboxReason, type InboxItem, type OwnerView } from "@/lib/inbox";
import { stopLine, stopView } from "@/lib/stop";
import { AUTONOMY_LABELS, type ReviewSummary } from "@/lib/merge-decision";
import { sourceLink } from "@/lib/sources/shapes";
import { cn } from "@/lib/utils";
import type { BoardCard } from "./cards";
import { Media } from "./media";
import { EvidenceSummaryList } from "./evidence";
import { InboxActions } from "./inbox-actions";
import { type BadgeTone, type Block, BLOCK_LABEL, dangerBlock, inboxBlocks, kindBadge } from "./inbox-model";
import { FullViewToggle, useEscapeToSidePanel, type FullView } from "./full-view";
import { inboxHref, jobsHref } from "./job-view";
import { Confidence } from "./merge-decision";
import { useRowKeys } from "./row-keys";
import { ShortTime } from "./time";

/** Badge colours: lime is PR ready only (Q66), and selection is Unibuz blue. */
const TONE: Record<BadgeTone, string> = {
  input: "bg-(--primary-soft) text-primary",
  ready: "bg-(--lime) text-(--on-lime)",
  testing: "bg-(--warning-soft) text-warning",
  failed: "bg-(--danger-soft) text-destructive",
};

const Pill = ({ tone, children }: { tone: BadgeTone; children: ReactNode }) => (
  <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", TONE[tone])}>{children}</span>
);

type Item = InboxItem<JobRow>;

function Row({
  item,
  href,
  open,
  cursor,
  onFocus,
  repoLabels,
}: {
  item: Item;
  href: string;
  open: boolean;
  cursor: boolean;
  onFocus: () => void;
  repoLabels: ReadonlyMap<string, string> | undefined;
}) {
  const { job } = item;
  const badge = kindBadge(item);
  return (
    <Link
      href={href}
      scroll={false}
      data-row={job.key}
      onFocus={onFocus}
      aria-current={open ? "true" : undefined}
      className={cn(
        "flex flex-col gap-1.5 rounded-2xl border-[1.5px] border-transparent p-3.5 text-left transition-colors duration-150 hover:bg-(--surface-2) focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring",
        open ? "border-primary bg-(--primary-soft)" : cursor && "bg-(--surface-2)",
      )}
    >
      <span className="flex items-center justify-between gap-2">
        <Pill tone={badge.tone}>{badge.label}</Pill>
        <span className="text-xs text-muted-foreground tabular-nums">
          <ShortTime date={item.at} />
        </span>
      </span>
      <span className="font-medium">{job.title}</span>
      <span className="text-xs text-muted-foreground">{`${job.key} · ${repoLabels?.get(job.repo) ?? job.repo} · ${inboxReason(item)}`}</span>
    </Link>
  );
}

/** A labelled block of the detail; the first one sits in a well, on `--danger-soft` for a failure. */
function Section({ title, well = false, danger = false, children }: { title: string; well?: boolean; danger?: boolean; children: ReactNode }) {
  return (
    <section className={cn("flex flex-col gap-2", well && ["rounded-xl p-3.5", danger ? "bg-(--danger-soft)" : "bg-(--surface-2)"])}>
      <h3 className={cn("text-xs font-medium tracking-wide uppercase", well && danger ? "text-destructive" : "text-muted-foreground")}>{title}</h3>
      {children}
    </section>
  );
}

function Why({ item }: { item: Item }) {
  const { kind, job, decision } = item;
  switch (kind) {
    case "question":
    case "plan_approval":
      return <p className="whitespace-pre-wrap">{job.question ?? job.stage_summary}</p>;
    case "failed": {
      const stop = stopView(job.stop, job.execution === "modal");
      return (
        <div className="flex flex-col gap-1">
          <p className="whitespace-pre-wrap">{job.stage_summary ?? "The job failed without a summary."}</p>
          {stop?.kind === "stopping" && <p className="text-xs text-muted-foreground">{stopLine(stop)}</p>}
        </div>
      );
    }
    case "stop_unconfirmed":
      return (
        <Alert variant="warning" className="border-0 bg-transparent p-0">
          <AlertDescription className="flex flex-col gap-1">
            <span>{inboxReason(item)}</span>
            <span>
              Open the run, then Open in T3, and stop the thread there if it still works; then dismiss this. Retry stop asks T3 to interrupt it again. The label
              can&apos;t retry the job until this is dismissed.
            </span>
          </AlertDescription>
        </Alert>
      );
    case "revert_failed": {
      const watch = decision?.watch;
      return (
        <Alert variant="error" className="border-0 bg-transparent p-0">
          <AlertDescription className="flex flex-col gap-1 text-foreground">
            {watch?.reason && <span>{watch.reason}</span>}
            {watch && watch.failed.length > 0 && (
              <span>
                Failed on {decision?.merged?.base ?? "main"}: {watch.failed.join(", ")}
              </span>
            )}
            {watch?.revertPr && (
              <a href={watch.revertPr} target="_blank" rel="noreferrer" className="underline underline-offset-2">
                Revert PR
              </a>
            )}
          </AlertDescription>
        </Alert>
      );
    }
    case "handover": {
      if (!decision) return <p className="text-muted-foreground">The runner hasn&apos;t looked at this pull request yet.</p>;
      if (decision.autonomy === "off")
        return <p className="text-muted-foreground">Merging is off for {job.repo}, so every pull request waits for your review.</p>;
      if (decision.outcome === "merge") return <p className="text-muted-foreground">Trial would merge it; under trial the factory never merges on its own.</p>;
      return (
        <div className="flex flex-col gap-1">
          <ul className="list-disc pl-4">
            {decision.reasons.map((r, i) => (
              <li key={i}>{r}</li>
            ))}
          </ul>
          <p className="text-xs text-faint">{AUTONOMY_LABELS[decision.autonomy]} · approving overrules the agent&apos;s and the policy&apos;s reasons</p>
        </div>
      );
    }
    default: {
      const never: never = kind;
      throw new Error(`unknown inbox kind ${String(never)}`);
    }
  }
}

function Reading({ assessment }: { assessment: NonNullable<ReturnType<typeof parseAssessment>> }) {
  return (
    <div className="flex flex-col gap-2">
      <Confidence assessment={assessment} />
      {assessment.notes && <p className="whitespace-pre-wrap">{assessment.notes}</p>}
      {assessment.assumptions.length > 0 && (
        <>
          <h4 className="mt-1.5 text-xs font-medium tracking-wide text-muted-foreground uppercase">Assumptions it made</h4>
          <ul className="list-disc pl-4 text-muted-foreground">
            {assessment.assumptions.map((a, i) => (
              <li key={i}>{a}</li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}

type Loaded = { kind: "loading" } | { kind: "ready"; review: ReviewSummary | null } | { kind: "failed"; message: string };

/** The PR's files and Bugbot's findings, read on the server so the browser never calls GitHub. */
function useReview(job: JobRow, wanted: boolean) {
  const [loaded, setLoaded] = useState<Loaded>({ kind: "loading" });
  const head = job.stage_event_id;
  useEffect(() => {
    if (!wanted) return;
    const controller = new AbortController();
    fetch(`/api/jobs/${encodeURIComponent(job.key)}/review`, { signal: controller.signal })
      .then(async (res) => {
        const body = (await res.json().catch(() => ({}))) as { review?: ReviewSummary | null; error?: string };
        setLoaded(res.ok ? { kind: "ready", review: body.review ?? null } : { kind: "failed", message: body.error ?? `The panel answered ${res.status}.` });
      })
      .catch((error: unknown) => controller.signal.aborted || setLoaded({ kind: "failed", message: String(error) }));
    return () => controller.abort();
  }, [job.key, head, wanted]);
  return loaded;
}

function bugbotLine(bugbot: ReviewSummary["bugbot"]) {
  switch (bugbot.state) {
    case "pending":
      return { text: "Bugbot hasn't finished its review.", tone: "text-muted-foreground" };
    case "failed":
      return { text: "Bugbot didn't complete its review.", tone: "text-warning" };
    case "reviewed": {
      const open = [bugbot.high && `${bugbot.high} high`, bugbot.medium && `${bugbot.medium} medium`, bugbot.low && `${bugbot.low} low`].filter(Boolean);
      const resolved = bugbot.resolved ? ` · ${bugbot.resolved} resolved` : "";
      if (open.length === 0) return { text: `No open findings${resolved}`, tone: "text-success" };
      return { text: `${open.join(", ")} unresolved${resolved}`, tone: bugbot.high || bugbot.medium ? "text-destructive" : "text-muted-foreground" };
    }
    default: {
      const never: never = bugbot.state;
      throw new Error(`unknown Bugbot state ${String(never)}`);
    }
  }
}

function Review({ loaded, prUrl }: { loaded: Loaded; prUrl: string }) {
  if (loaded.kind === "loading") {
    return (
      <Section title={BLOCK_LABEL.changes}>
        <div className="flex flex-col gap-1.5">
          <Skeleton className="h-4 w-2/3" />
          <Skeleton className="h-4 w-1/2" />
          <Skeleton className="h-4 w-3/5" />
        </div>
      </Section>
    );
  }
  if (loaded.kind === "failed") {
    return (
      <Section title={BLOCK_LABEL.changes}>
        <p className="text-muted-foreground">{loaded.message}</p>
      </Section>
    );
  }
  const review = loaded.review;
  if (!review) return null;
  const added = review.files.reduce((sum, f) => sum + f.additions, 0);
  const removed = review.files.reduce((sum, f) => sum + f.deletions, 0);
  const files = `${prUrl}/files`;
  return (
    <>
      <Section title={`${BLOCK_LABEL.changes} · +${added} −${removed}`}>
        <ul className="flex flex-col">
          {review.files.map((f) => (
            <li key={f.path} className="border-t first:border-t-0">
              <a href={files} target="_blank" rel="noreferrer" className="grid grid-cols-[minmax(0,1fr)_auto_auto] gap-2.5 py-1.5 font-mono text-xs">
                <span className="truncate" title={f.path}>
                  {f.path}
                </span>
                <span className="tabular-nums text-success">+{f.additions}</span>
                <span className="tabular-nums text-destructive">−{f.deletions}</span>
              </a>
            </li>
          ))}
        </ul>
        {review.fileCount > review.files.length && (
          <a href={files} target="_blank" rel="noreferrer" className="text-xs text-muted-foreground underline underline-offset-2">
            and {review.fileCount - review.files.length} more on GitHub
          </a>
        )}
      </Section>
    </>
  );
}

function Detail({ item, card, fullView, owner }: { item: Item; card: BoardCard | undefined; fullView: FullView; owner: OwnerView }) {
  const { job, kind } = item;
  useEscapeToSidePanel(fullView);
  const link = sourceLink(job);
  const wantsReview = kind !== "question" && kind !== "plan_approval" && job.pr_url !== null;
  const loaded = useReview(job, wantsReview);
  const review = loaded.kind === "ready" ? loaded.review : null;
  const assessment = parseAssessment(job.merge_assessment);
  const badge = kindBadge(item);
  const bugbot = review && kind === "handover" ? bugbotLine(review.bugbot) : null;
  // A block's body; null leaves the block out.
  const body = (block: Block): ReactNode => {
    switch (block) {
      case "evidence": {
        const evidence = job.stage === "pr" ? <EvidenceSummaryList job={job} /> : null;
        const media = assessment?.media?.length ? <Media job={job} assessment={assessment} /> : null;
        return evidence || media ? (
          <>
            {evidence}
            {media}
          </>
        ) : null;
      }
      case "reading":
        return assessment && <Reading assessment={assessment} />;
      case "changes":
        return wantsReview && job.pr_url ? <Review loaded={loaded} prUrl={job.pr_url} /> : null;
      case "asked":
      case "plan":
      case "why":
      case "failed":
      case "revert":
      case "stop":
        return <Why item={item} />;
      default: {
        const never: never = block;
        throw new Error(`unknown inbox block ${String(never)}`);
      }
    }
  };
  const blocks = inboxBlocks(kind)
    .map((id) => ({ id, node: body(id) }))
    .filter((b) => b.node);
  return (
    <aside aria-label={`${job.key} details`} className="m-3 flex min-h-0 min-w-0 flex-col overflow-hidden rounded-2xl border bg-card">
      <ScrollArea className="min-h-0 flex-1">
        <div className={cn("flex flex-col gap-4 px-4.5 py-4", fullView.full && "mx-auto w-full max-w-3xl")}>
          <div className="flex flex-col gap-2">
            <div className="flex items-center justify-between font-mono text-xs text-faint">
              <span>{`${job.key} · ${job.repo}`}</span>
              <span className="flex items-center gap-0.5">
                <FullViewToggle {...fullView} />
                <Button render={<Link href={inboxHref(owner)} scroll={false} />} variant="ghost" size="icon-sm" aria-label="Close">
                  <XIcon />
                </Button>
              </span>
            </div>
            <h2 className="text-2xl font-semibold">{job.title}</h2>
            <div className="flex flex-wrap items-center gap-2">
              <Pill tone={badge.tone}>{badge.label}</Pill>
              <span className="ml-auto flex flex-wrap gap-2">
                {card?.latest && (
                  <Button render={<Link href={jobsHref("list", card.latest.session_id, false, owner)} scroll={false} />} variant="ghost" size="sm">
                    Run
                  </Button>
                )}
                <Button render={<a href={link.href} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                  {link.label}
                  <ExternalLinkIcon data-icon="inline-end" />
                </Button>
                {job.pr_url && (
                  <Button render={<a href={job.pr_url} target="_blank" rel="noreferrer" />} variant="outline" size="sm">
                    Pull request
                    <ExternalLinkIcon data-icon="inline-end" />
                  </Button>
                )}
              </span>
            </div>
          </div>
          {bugbot && <p className={cn("w-fit rounded-full bg-(--surface-2) px-2 py-0.5 text-xs font-medium", bugbot.tone)}>{bugbot.text}</p>}
          {blocks.map(({ id, node }, i) =>
            id === "changes" ? (
              <Fragment key={id}>{node}</Fragment>
            ) : (
              <Section key={id} title={BLOCK_LABEL[id]} well={i === 0} danger={dangerBlock(kind)}>
                {node}
              </Section>
            ),
          )}
          <InboxActions
            job={job}
            kind={kind}
            decision={item.decision}
            headSha={review?.headSha ?? null}
            reviewReady={!wantsReview || loaded.kind !== "loading"}
          />
        </div>
      </ScrollArea>
    </aside>
  );
}

/** Everything waiting on the owner as one dense list; Enter opens an item's detail and actions on the right. */
export function Inbox({
  jobs,
  cards,
  selected,
  repoLabels,
  fullView,
  owner,
}: {
  jobs: readonly JobRow[];
  cards: readonly BoardCard[];
  selected: string | undefined;
  /** Whether the open item fills the page instead of sitting beside the list. */
  fullView: FullView;
  /** Each repo's short name, while more than one repo has jobs; undefined shows no repo. */
  repoLabels?: ReadonlyMap<string, string>;
  /** The resolved owner view, so links keep it even on a bare URL. */
  owner: OwnerView;
}) {
  const itemHref = (key: string) => inboxHref(owner, key);
  const items = useMemo(() => inboxItems(jobs), [jobs]);
  const listRef = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState<string | null>(selected ?? null);
  const open = items.find((i) => i.job.key === selected);
  const full = fullView.full && open !== undefined;
  // In full view the list is hidden and Esc goes back to the side panel, which the detail handles.
  useRowKeys(listRef, { cursor, setCursor, hrefOf: itemHref, closeHref: selected ? inboxHref(owner) : null, enabled: !full });

  if (items.length === 0) {
    return (
      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>Nothing needs you right now.</EmptyTitle>
            <EmptyDescription>Questions, pull requests ready for your review and failures land here.</EmptyDescription>
          </EmptyHeader>
        </Empty>
      </div>
    );
  }

  return (
    <div className={cn("grid min-h-0 flex-1", open && !full ? "grid-cols-[minmax(0,1fr)_440px] xl:grid-cols-[minmax(0,1fr)_520px]" : "grid-cols-1")}>
      {!full && (
        <div ref={listRef} className="@container min-h-0 min-w-0 overflow-y-auto">
          <ul aria-label="Needs you" className="flex flex-col gap-1 p-3">
            {items.map((item) => (
              <li key={item.job.key}>
                <Row
                  item={item}
                  href={itemHref(item.job.key)}
                  open={item === open}
                  cursor={cursor === item.job.key}
                  onFocus={() => setCursor(item.job.key)}
                  repoLabels={repoLabels}
                />
              </li>
            ))}
          </ul>
        </div>
      )}
      {open && <Detail key={open.job.key} item={open} card={cards.find((c) => c.id === open.job.key)} fullView={fullView} owner={owner} />}
    </div>
  );
}
