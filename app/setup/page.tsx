import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupSteps } from "@/components/auth/setup-steps";
import { currentUser } from "@/lib/auth/server";
import { db } from "@/db/client";
import { accountMeters } from "@/lib/account-meters";
import { viewerOf } from "@/lib/inbox";
import { readSourceChoice } from "@/lib/job-sources";
import { linearCardNote, linearMatch, linearUsers, readOptIns } from "@/lib/opt-ins";
import { userByEmail } from "@/lib/slack-api";

export const metadata: Metadata = { title: "Setup · Hive" };

/**
 * First-run setup (R5, R33, R28, R27): Account saves the name and enrols TOTP, Linear saves the user's
 * pickup opt-ins and shows whether Linear knows their email, Agents connects their own accounts, Done sets setup_done_at.
 */
export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/auth/sign-in");
  // A Slack or Linear outage only leaves its card saying it found no match.
  const [slackUser, optIns, linear, sources, meters] = await Promise.all([
    userByEmail(user.email),
    readOptIns({ user: async () => user }),
    linearMatch(user.email, linearUsers()),
    readSourceChoice(db),
    accountMeters(db, viewerOf(user)),
  ]);
  return (
    <main className="flex min-h-svh justify-center px-4 pt-16 pb-12">
      <SetupSteps
        accounts={meters.mine}
        linear={{ matched: linear === "matched", note: linearCardNote(linear, user.email) }}
        optIns={optIns}
        sources={sources}
        user={{
          name: user.name || user.email,
          email: user.email,
          role: user.role === "admin" ? "admin" : "engineer",
          twoFactorEnabled: user.twoFactorEnabled === true,
          slackMatched: slackUser !== null,
        }}
      />
    </main>
  );
}
