import type { JobRow } from "@/db/schema";
import { INBOX_LABELS, type InboxItem, type InboxKind } from "@/lib/inbox";
import { isApproval } from "@/lib/plan-approval";

// What the Inbox draws for each kind of item, as pure rules so the regressions cover them (R25e).

/** The labelled blocks an item's detail shows. */
export type Block = "asked" | "plan" | "why" | "evidence" | "reading" | "changes" | "failed" | "revert" | "stop";

export const BLOCK_LABEL: Record<Block, string> = {
  asked: "The agent asked · also posted on Linear",
  plan: "Plan for your approval",
  why: "Why it's here",
  evidence: "Evidence",
  reading: "Agent's reading",
  changes: "Changed files",
  failed: "Why it failed",
  revert: "Main went red and the revert failed",
  stop: "Stop not confirmed",
};

/** Each kind's blocks in order: a handover reads why, what the agent concluded, what it touched and what ran; the other kinds lead with their reason, then show whatever evidence, assessment and review the job has. */
export function inboxBlocks(kind: InboxKind): readonly Block[] {
  switch (kind) {
    case "question":
      return ["asked"];
    case "plan_approval":
      return ["plan"];
    case "handover":
      return ["why", "reading", "changes", "evidence"];
    case "failed":
      return ["failed", "evidence", "reading", "changes"];
    case "revert_failed":
      return ["revert", "evidence", "reading", "changes"];
    case "stop_unconfirmed":
      return ["stop", "evidence", "reading", "changes"];
    default: {
      const never: never = kind;
      throw new Error(`unknown inbox kind ${String(never)}`);
    }
  }
}

/** The kinds whose reason is the point of the item, so it gets a well on `--danger-soft` with a destructive label. */
export const dangerBlock = (kind: InboxKind) => kind === "failed" || kind === "revert_failed";

export type BadgeTone = "input" | "ready" | "testing" | "failed";

/** The card's badge: `ready` is lime, which is PR ready only, so no other kind takes it (Q66). */
export function kindBadge(item: InboxItem<JobRow>): { label: string; tone: BadgeTone } {
  switch (item.kind) {
    case "question":
    case "plan_approval":
    case "stop_unconfirmed":
      return { label: INBOX_LABELS[item.kind], tone: "input" };
    case "handover":
      return item.decision?.outcome === "merge" ? { label: "Would merge", tone: "ready" } : { label: INBOX_LABELS.handover, tone: "testing" };
    case "failed":
    case "revert_failed":
      return { label: INBOX_LABELS[item.kind], tone: "failed" };
    default: {
      const never: never = item.kind;
      throw new Error(`unknown inbox kind ${String(never)}`);
    }
  }
}

/** Retry's label names the attempt it starts; `jobs.attempt` counts the one that failed. */
export const retryLabel = (job: Pick<JobRow, "attempt">) => `Retry as attempt ${job.attempt + 1}`;

/** Whether Request changes may send: it needs text, and on a plan it must not read as an approval, which would resume as one. */
export const canRequestChanges = (kind: InboxKind, text: string) => text.trim() !== "" && (kind !== "plan_approval" || !isApproval(text));
