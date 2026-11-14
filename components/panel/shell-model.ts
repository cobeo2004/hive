import type { JobRow } from "@/db/schema";
import { type ArchiveJob, isFinished, splitArchived } from "@/lib/archive";
import { inboxItems, ownedBy, type Viewer } from "@/lib/inbox";

// What the sidebar and the breadcrumb bar show, as pure rules so the regressions cover them.

/** The stages where an agent is at work: not queued (not started) and not waiting (that is "Waiting on you"). */
const RUNNING: ReadonlySet<string> = new Set(["triage", "investigating", "planning", "implementing", "verifying", "pr"]);

type ShellJob = ArchiveJob & Pick<JobRow, "owner_id" | "claimed_at">;

/** The running jobs outside the archive, most recently claimed first. */
export function workingJobs<J extends ShellJob>(rows: readonly J[]): J[] {
  return splitArchived(rows)
    .shown.filter((j) => RUNNING.has(j.stage))
    .sort((a, b) => b.claimed_at.getTime() - a.claimed_at.getTime());
}

/** The viewer's own Inbox items' jobs outside the archive, in the Inbox's order; its length is the Inbox badge's number. */
export function waitingJobs<J extends ShellJob>(rows: readonly J[], me: Viewer | null): J[] {
  return inboxItems(ownedBy(splitArchived(rows).shown, "mine", me)).map((item) => item.job);
}

/** Finished jobs outside the archive, across everyone, most recently finished first. */
export function settledJobs<J extends ShellJob>(rows: readonly J[]): J[] {
  const at = (j: J) => (j.stage_at ?? j.updated_at).getTime();
  return splitArchived(rows)
    .shown.filter((j) => isFinished(j.stage))
    .sort((a, b) => at(b) - at(a));
}

const CRUMBS: Record<string, string> = {
  inbox: "Inbox",
  repositories: "Repositories",
  settings: "Settings",
  machines: "Machines",
  activity: "Other activity",
  list: "List",
};

const decode = (segment: string) => {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
};

export function crumbsOf(pathname: string): string[] {
  const segments = pathname.split("/").filter(Boolean);
  if (segments.length === 0) return ["Hive", "Jobs"];
  return ["Hive", ...segments.map((s) => CRUMBS[s] ?? decode(s).replace(/^./, (c) => c.toUpperCase()))];
}

const TONES = ["bg-primary/15 text-info", "bg-success/15 text-success", "bg-warning/15 text-warning"] as const;

/** The repo's short name, a two-letter mark from its last word and a tone that stays the same for the same name. */
export function repoBadge(repo: string) {
  const name = repo.slice(repo.indexOf("/") + 1);
  const mark = (name.split("-").at(-1) ?? name).slice(0, 2).toUpperCase();
  let sum = 0;
  for (const ch of name) sum += ch.charCodeAt(0);
  return { name, mark, tone: TONES[sum % 3] };
}

// ponytail: same rule as credsProvider / DEFAULT_PROVIDER, inlined because lib/creds.ts imports node:crypto.
export const harnessChip = (provider: string | null) => (provider === null ? null : provider === "claudeAgent" ? "CC" : "CX");

export function elapsed(ms: number) {
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The repo's Workflow page (Q41); the segment is the encoded `owner/name`. */
export const workflowHref = (repo: string) => `/repositories/${encodeURIComponent(repo)}/workflow`;
export const wikiHref = (repo: string) => `/repositories/${encodeURIComponent(repo)}/wiki`;

/** Whether a sidebar link is the page shown, whether or not the pathname keeps the `owner%2Fname` segment encoded. */
export const isCurrent = (href: string, pathname: string) => decode(pathname) === decode(href);
