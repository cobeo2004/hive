import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { SetupSteps } from "@/components/auth/setup-steps";
import { currentUser } from "@/lib/auth/server";

export const metadata: Metadata = { title: "Setup · Hive" };

/** First-run setup (R5, R33): Account enrols TOTP, Done sets setup_done_at. PR4 extends it to the rest of the design. */
export default async function SetupPage() {
  const user = await currentUser();
  if (!user) redirect("/auth/sign-in");
  return (
    <main className="flex min-h-svh justify-center px-4 pt-16 pb-12">
      <SetupSteps
        user={{ name: user.name || user.email, email: user.email, role: user.role === "admin" ? "admin" : "engineer", twoFactorEnabled: user.twoFactorEnabled === true }}
      />
    </main>
  );
}
