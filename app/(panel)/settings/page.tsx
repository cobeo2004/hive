import { connection } from "next/server";
import { Suspense } from "react";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { LinearSettingsSection } from "@/components/panel/linear-settings";
import { PanelHeader } from "@/components/panel/panel-header";
import { SettingsForm } from "@/components/panel/settings-form";
import { GithubLinkSection } from "@/components/panel/github-link";
import { FormSkeleton, PageSkeleton } from "@/components/panel/skeletons";
import { TeamPoolSection } from "@/components/panel/team-pool";
import { listMembers } from "@/app/actions/members";
import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/owner";
import { loadLimits } from "@/lib/config";
import { viewerOf } from "@/lib/inbox";
import { linearSettings, linearUserName } from "@/lib/linear-settings";
import { poolAccounts } from "@/lib/pool-accounts";
import { load, machinesQuery } from "@/lib/live-queries";
import { readNotifications } from "@/lib/notifications";
import { readSettings } from "@/lib/settings";
import { readSourceChoice } from "@/lib/job-sources";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // Settings is admin-only (R4); an engineer sees only Settings → Linear, read-only (R7a).
  const user = await currentUser();
  if (!user) return <ForbiddenCard reason="admin" />;
  const [saved, accounts, sources] = await Promise.all([linearSettings(db), poolAccounts(db, viewerOf(user)), readSourceChoice(db)]);
  const linear = { saved, userName: await linearUserName(process.env.LINEAR_API_KEY, saved.hiveUserId) };
  const admin = isAdmin(user);
  const teamPool = (
    <>
      <GithubLinkSection />
      <TeamPoolSection accounts={accounts} pool={loadLimits().pool} readOnly={!admin} />
    </>
  );
  if (!admin)
    return (
      <>
        <PanelHeader title="Settings" />
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto flex w-full max-w-6xl flex-col divide-y p-4 md:p-8">
            {sources !== "github" && <LinearSettingsSection {...linear} readOnly />}
            {teamPool}
          </div>
        </div>
      </>
    );
  // load checks the member before anything is read.
  const [machines, members] = await Promise.all([load(machinesQuery()), listMembers()]);
  const [settings, notifications] = await Promise.all([readSettings(db), readNotifications(db)]);
  return (
    <SettingsForm
      machines={machines}
      members={members.ok ? members.members : []}
      saved={settings}
      notifications={notifications}
      linear={linear}
      sources={sources}
      githubForced={sources === "linear" && process.env.FACTORY_GITHUB_ISSUES === "on"}
    >
      {teamPool}
    </SettingsForm>
  );
}

export default function SettingsPage() {
  return (
    <Suspense
      fallback={
        <PageSkeleton title="Settings">
          <FormSkeleton />
        </PageSkeleton>
      }
    >
      <Panel />
    </Suspense>
  );
}
