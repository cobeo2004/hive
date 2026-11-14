import { cookies } from "next/headers";
import { Suspense } from "react";
import { InboxCount } from "@/components/panel/inbox-count";
import { type Feed, LiveRefresh } from "@/components/panel/live-refresh";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";
import { SidebarJobs, SidebarRepos } from "@/components/panel/sidebar-jobs";
import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import type { JobRow } from "@/db/schema";
import { viewerOf, type Viewer } from "@/lib/inbox";
import { jobsQuery, load } from "@/lib/live-queries";
import { readRegistry } from "@/lib/repositories";

type Props = { feed: Promise<Feed<JobRow>>; me: Viewer | null };

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  const collapsed = (await cookies()).get(COLLAPSED_COOKIE)?.value === "false";
  // The proxy keeps everyone without a member session out, so the rail always has someone to sign out.
  const user = await currentUser();
  const me = viewerOf(user);
  // One query feeds the Inbox count and the sidebar's Working list; each streams in its own boundary.
  const feed = load(jobsQuery());
  return (
    <>
      <LiveRefresh />
      <PanelShell
        defaultCollapsed={collapsed}
        inboxCount={
          <Suspense fallback={null}>
            <Count feed={feed} me={me} />
          </Suspense>
        }
        sidebar={
          <>
            <Suspense fallback={null}>
              <Repos />
            </Suspense>
            <Suspense fallback={null}>
              <Working feed={feed} me={me} />
            </Suspense>
          </>
        }
        user={{ name: user?.name || user?.email || "Hive", email: user?.email ?? "" }}
      >
        {children}
      </PanelShell>
    </>
  );
}

const Count = async ({ feed, me }: Props) => <InboxCount jobs={await feed} me={me} />;
const Working = async ({ feed, me }: Props) => <SidebarJobs jobs={await feed} me={me} />;
// repo_settings is not in hive_changes; the Repositories page refreshes the router after each change, which re-renders this list.
const Repos = async () => <SidebarRepos repos={(await load(readRegistry(db))).initialData.map((r) => r.repo)} />;
