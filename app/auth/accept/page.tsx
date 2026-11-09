import type { Metadata } from "next";
import { checkLink } from "@/app/actions/access";
import { AuthShell, INVALID_LINK, InviteForm } from "@/components/auth/link-forms";

export const metadata: Metadata = { title: "Accept your invite · Hive" };

export default async function Page({ searchParams }: PageProps<"/auth/accept">) {
  const { token } = await searchParams;
  const query = typeof token === "string" ? token : null;
  const link = query ? await checkLink("invite", query) : null;
  return (
    <AuthShell description={link ? "You join Hive as an engineer. Next comes two-factor authentication." : INVALID_LINK} title="Accept your invite">
      {query && link?.email && <InviteForm email={link.email} token={query} />}
    </AuthShell>
  );
}
