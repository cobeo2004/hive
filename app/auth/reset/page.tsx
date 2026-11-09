import type { Metadata } from "next";
import { checkLink } from "@/app/actions/access";
import { AuthShell, INVALID_LINK, ResetForm } from "@/components/auth/link-forms";

export const metadata: Metadata = { title: "Reset your password · Hive" };

export default async function Page({ searchParams }: PageProps<"/auth/reset">) {
  const { token } = await searchParams;
  const query = typeof token === "string" ? token : null;
  const link = query ? await checkLink("reset", query) : null;
  return (
    <AuthShell
      description={link ? `Choose a new password for ${link.email}. Everyone signed in with the old one is signed out.` : INVALID_LINK}
      title="Reset your password"
    >
      {query && link && <ResetForm token={query} />}
    </AuthShell>
  );
}
