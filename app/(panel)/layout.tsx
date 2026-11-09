import { cookies } from "next/headers";
import { Suspense } from "react";
import { InboxCount } from "@/components/panel/inbox-count";
import { LiveRefresh } from "@/components/panel/live-refresh";
import { COLLAPSED_COOKIE, PanelShell } from "@/components/panel/panel-shell";
import { currentUser } from "@/lib/auth/server";
import { jobsQuery, load } from "@/lib/live-queries";

async function LiveInboxCount() {
  return <InboxCount jobs={await load(jobsQuery())} />;
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
            <LiveInboxCount />
          </Suspense>
        }
        user={{ name: user?.name || user?.email || "Hive", email: user?.email ?? "" }}
      >
        {children}
      </PanelShell>
    </>
  );
}
