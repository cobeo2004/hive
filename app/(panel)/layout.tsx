import { cookies } from "next/headers";
import { Suspense } from "react";
import { InboxCount } from "@/components/panel/inbox-count";
import { LiveRefresh } from "@/components/panel/live-refresh";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";
import { currentUser } from "@/lib/auth/server";
import { viewerOf, type Viewer } from "@/lib/inbox";
import { jobsQuery, load } from "@/lib/live-queries";

async function LiveInboxCount({ me }: { me: Viewer | null }) {
  return <InboxCount jobs={await load(jobsQuery())} me={me} />;
}

export default async function PanelLayout({ children }: LayoutProps<"/">) {
  const collapsed = (await cookies()).get(COLLAPSED_COOKIE)?.value === "false";
  // The proxy keeps everyone without a member session out, so the rail always has someone to sign out.
  const user = await currentUser();
  return (
    <>
      <LiveRefresh />
      <PanelShell
        defaultCollapsed={collapsed}
        inboxCount={
          <Suspense fallback={null}>
            <LiveInboxCount me={viewerOf(user)} />
          </Suspense>
        }
        user={{ name: user?.name || user?.email || "Hive", email: user?.email ?? "" }}
      >
        {children}
      </PanelShell>
    </>
  );
}
