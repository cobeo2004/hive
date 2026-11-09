import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupSteps } from "@/components/auth/link-forms";
import { currentUser } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Setup · Hive" };

/** First-run setup (R5, R33): Account enrols TOTP, Done sets setup_done_at. PR4 extends it to the design. */
export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/auth/sign-in");
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-lg font-medium">Set up your account</h1>
      <p className="text-sm">
        {user.email} · {user.role}
      </p>
      <SetupSteps enrolled={user.twoFactorEnabled === true} />
    </main>
  );
}
