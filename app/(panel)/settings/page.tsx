import { connection } from "next/server";
import { Suspense } from "react";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { LinearSettingsSection } from "@/components/panel/linear-settings";
import { SettingsForm } from "@/components/panel/settings-form";
import { GithubLinkSection } from "@/components/panel/github-link";
import { SettingsGroup, SettingsLayout, SettingsSection } from "@/components/panel/settings-section";
import { FormSkeleton, PageSkeleton } from "@/components/panel/skeletons";
import { TeamPoolSection } from "@/components/panel/team-pool";
import { YourAccounts } from "@/components/panel/your-accounts";
import { listMembers } from "@/app/actions/members";
import { db } from "@/db/client";
import { accountMeters } from "@/lib/account-meters";
import { currentUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/owner";
import { loadLimits } from "@/lib/config";
import { viewerOf } from "@/lib/inbox";
import { linearSettings, linearUserName } from "@/lib/linear-settings";
import { poolAccounts } from "@/lib/pool-accounts";
import { load, machinesQuery } from "@/lib/live-queries";
import { readNotifications } from "@/lib/notifications";
import { readSettings } from "@/lib/settings";
import { testJobStatus } from "@/lib/settings-test-job";
import { readSourceChoice } from "@/lib/job-sources";

async function Panel() {
  // Without a search param to make the page dynamic, Next would try to prerender it and log the cookie read as an error.
  await connection();
  // Settings is admin-only (R4); an engineer sees only Settings → Linear, read-only (R7a).
  const user = await currentUser();
  if (!user) return <ForbiddenCard reason="admin" />;
  const viewer = viewerOf(user);
  const [saved, accounts, sources, meters] = await Promise.all([linearSettings(db), poolAccounts(db, viewer), readSourceChoice(db), accountMeters(db, viewer)]);
  const linear = { saved, userName: await linearUserName(process.env.LINEAR_API_KEY, saved.hiveUserId) };
  const admin = isAdmin(user);
  const teamPool = (
    <>
      <GithubLinkSection />
      <SettingsGroup id="subs" title="Subscriptions" description="Runs bill to the assignee’s own subscription first, then fall back to the team pool.">
        <SettingsSection id="your-accounts" title="Your accounts" description="Jobs you own run on your own subscriptions first, then on the team pool.">
          <YourAccounts accounts={meters.mine} manage />
        </SettingsSection>
        <TeamPoolSection accounts={accounts} pool={loadLimits().pool} readOnly={!admin} />
      </SettingsGroup>
    </>
  );
  if (!admin)
    return (
      <SettingsLayout
        sub="Engineers see GitHub, Your accounts, the team pool and the Linear opt-in; an admin changes the rest."
        nav={[...(sources !== "github" ? [["linear", "Linear"] as const] : []), ["github-link", "GitHub"], ["subs", "Subscriptions"]]}
      >
        {sources !== "github" && <LinearSettingsSection {...linear} readOnly />}
        {teamPool}
      </SettingsLayout>
    );
  // load checks the member before anything is read.
  const [machines, members] = await Promise.all([load(machinesQuery()), listMembers()]);
  const [settings, notifications, testJob] = await Promise.all([readSettings(db), readNotifications(db), testJobStatus(db)]);
  return (
    <SettingsForm
      machines={machines}
      testJob={testJob}
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
