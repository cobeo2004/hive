import type { Metadata } from "next";
import { checkLink } from "@/app/actions/access";
import { AuthShell, INVALID_LINK, SetupLinkForm } from "@/components/auth/link-forms";

export const metadata: Metadata = { title: "Create the first admin · Hive" };

export default async function Page({ searchParams }: PageProps<"/auth/setup">) {
  const { token } = await searchParams;
  const query = typeof token === "string" ? token : null;
  const link = query ? await checkLink("setup", query) : null;
  return (
    <AuthShell
      description={link ? "This makes the first Hive admin. The link works once and closes as soon as an admin exists." : INVALID_LINK}
      title="Create the first admin"
    >
      {query && link && <SetupLinkForm token={query} />}
    </AuthShell>
  );
}
