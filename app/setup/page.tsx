import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupSteps } from "@/components/auth/setup-steps";
import { currentUser } from "@/lib/auth/server";
import { linearCardNote, linearMatch, linearUsers, readOptIns, SETUP_STEPS } from "@/lib/opt-ins";
import { userByEmail } from "@/lib/slack-api";

export const metadata: Metadata = { title: "Setup · Hive" };

/**
 * First-run setup (R5, R33, R28): Account saves the name and enrols TOTP, Linear saves the user's
 * pickup opt-ins and shows whether Linear knows their email, Done sets setup_done_at.
 */
export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/auth/sign-in");
  // A Slack or Linear outage only leaves its card saying it found no match.
  const [slackUser, optIns, linear] = await Promise.all([
    userByEmail(user.email),
    readOptIns({ user: async () => user }),
    linearMatch(user.email, linearUsers()),
  ]);
  return (
    <main className="flex min-h-svh justify-center px-4 pt-16 pb-12">
      <SetupSteps
        linear={{ matched: linear === "matched", note: linearCardNote(linear, user.email) }}
        optIns={optIns}
        steps={SETUP_STEPS}
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
