import type { Metadata } from "next";
import { checkLink } from "@/app/actions/access";
import { InviteForm } from "@/components/auth/link-forms";

export const metadata: Metadata = { title: "Accept your invite · Hive" };

export default async function Page({ searchParams }: PageProps<"/auth/accept">) {
  const { token } = await searchParams;
  const link = typeof token === "string" ? await checkLink("invite", token) : null;
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-4 p-6">
      <h1 className="text-lg font-medium">Accept your invite</h1>
      {link && typeof token === "string" ? (
        <>
          {link.email && <p className="text-sm">{link.email}</p>}
          <InviteForm token={token} />
        </>
      ) : (
        <p>This link is invalid or used.</p>
      )}
    </main>
  );
}
