import { cookies } from "next/headers";
import { Suspense } from "react";
import { JOB_VIEW_COOKIE, parseJobView } from "@/components/panel/job-view";
import { LivePanel, type DetailProps, type PanelView } from "@/components/panel/live-panel";
import { PanelPageSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { accountMeters } from "@/lib/account-meters";
import { currentUser } from "@/lib/auth/server";
import { parseOwnerView, viewerOf } from "@/lib/inbox";
import {
  agentsOverviewQuery,
  jobAuditQuery,
  jobEvidenceQuery,
  jobsQuery,
  jobStagesQuery,
  deviceFrameQuery,
  load,
  machinesQuery,
  parseJobKey,
  runJob,
  runsQuery,
  sessionAgentsQuery,
  sessionEventsQuery,
  sessionStagesQuery,
} from "@/lib/live-queries";
import { REPO_FILTER_COOKIE, repoFilter } from "@/lib/repo-filter";
import { parseSessionId } from "@/lib/run-links";
import { readRegistry } from "@/lib/repositories";

async function loadDetail(sessionId: string): Promise<DetailProps> {
  const { jobKey, jobId } = await runJob(sessionId);
  const [agents, events, stages, audit, evidence, frame] = await Promise.all([
    load(sessionAgentsQuery(sessionId)),
    load(sessionEventsQuery(sessionId)),
    load(jobKey ? jobStagesQuery(jobKey) : sessionStagesQuery(sessionId)),
    jobId ? load(jobAuditQuery(jobId)) : undefined,
    jobId && jobKey ? load(jobEvidenceQuery(jobKey)) : undefined,
    jobKey ? load(deviceFrameQuery(jobKey)) : undefined,
  ]);
  return { sessionId, agents, events, stages, audit: jobKey ? audit : undefined, evidence, frame };
}

async function Panel({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const { run, job, view: rawView, owner: rawOwner, repo, archived } = await searchParams;
  const sessionId = parseSessionId(typeof run === "string" ? run : undefined);
  // Not awaited: the page streams while the run's own feeds load, and the side panel waits for them on its own.
  const detail = sessionId ? { sessionId, data: loadDetail(sessionId) } : undefined;
  const [jobs, runs, agents, machines, jar, user, meters] = await Promise.all([
    load(jobsQuery()),
    load(runsQuery()),
    load(agentsOverviewQuery()),
    load(machinesQuery()),
    cookies(),
    currentUser(),
    // currentUser() is request-cached, so this adds no query of its own.
    currentUser().then((u) => accountMeters(db, viewerOf(u))),
  ]);
  const jobView = parseJobView(rawView) ?? parseJobView(jar.get(JOB_VIEW_COOKIE)?.value) ?? "board";
  // Jobs opens on Everyone, the Inbox on Mine (unless a `?job=` link names an item, which may only be
  // listed on Everyone); `?view=mine|everyone` is accepted as the alias for `?owner=`.
  const owner = parseOwnerView(rawOwner) ?? parseOwnerView(rawView) ?? (view === "inbox" && typeof job !== "string" ? "mine" : "everyone");
  const me = viewerOf(user);
  // After the loads, which check the owner.
  const registry = await readRegistry(db);
  return (
    <LivePanel
      view={view}
      jobView={jobView}
      owner={owner}
      me={me}
      meters={meters}
      repo={repoFilter(repo, jar.get(REPO_FILTER_COOKIE)?.value)}
      archived={view === "jobs" && archived === "1"}
      registry={registry.map((r) => ({ repo: r.repo, display_name: r.display_name, enabled: r.enabled, is_default: r.is_default }))}
      jobs={jobs}
      runs={runs}
      agents={agents}
      machines={machines}
      detail={detail}
      inboxKey={typeof job === "string" ? parseJobKey(job) : undefined}
    />
  );
}

/** The inbox, the jobs page (board or list) and the other-activity page share their data, their live feeds and run detail. */
export function PanelPage({ view, searchParams }: { view: PanelView; searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  return (
    <Suspense fallback={<PanelPageSkeleton view={view} />}>
      <Panel view={view} searchParams={searchParams} />
    </Suspense>
  );
}
