import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupSteps } from "@/components/auth/setup-steps";
import { currentUser } from "@/lib/auth/server";
import { userByEmail } from "@/lib/slack-api";

export const metadata: Metadata = { title: "Setup · Hive" };

/** First-run setup (R5, R33): Account saves the name and enrols TOTP, Done sets setup_done_at. */
export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/auth/sign-in");
  // A Slack outage only leaves the Account step saying "Not found in Slack".
  const slackUser = await userByEmail(user.email);
  return (
    <main className="flex min-h-svh justify-center px-4 pt-16 pb-12">
      <SetupSteps
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
