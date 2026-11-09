import { connection } from "next/server";
import { Suspense } from "react";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { PanelHeader } from "@/components/panel/panel-header";
import { SettingsForm } from "@/components/panel/settings-form";
import { FormSkeleton, PageSkeleton } from "@/components/panel/skeletons";
import { listMembers } from "@/app/actions/members";
import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/owner";
import { load, machinesQuery } from "@/lib/live-queries";
import { readNotifications } from "@/lib/notifications";
import { readSettings } from "@/lib/settings";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // Settings is admin-only (R4), so an engineer gets the 403 card instead of a page whose every action refuses them.
  if (!isAdmin(await currentUser()))
    return (
      <>
        <PanelHeader title="Settings" />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ForbiddenCard reason="admin" />
        </div>
      </>
    );
  // load checks the member before anything is read.
  const [machines, members] = await Promise.all([load(machinesQuery()), listMembers()]);
  const [saved, notifications] = await Promise.all([readSettings(db), readNotifications(db)]);
  return <SettingsForm machines={machines} members={members.ok ? members.members : []} saved={saved} notifications={notifications} />;
}

export default function SettingsPage() {
  return (
    <Suspense fallback={<PageSkeleton title="Settings"><FormSkeleton /></PageSkeleton>}>
      <Panel />
    </Suspense>
  );
}
