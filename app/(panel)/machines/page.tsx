import { redirect } from "next/navigation";
import { connection } from "next/server";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { currentUser } from "@/lib/auth/server";
import { machinesRedirect } from "@/lib/machine";

/** Machines live in Settings → Machines & devices (R25g, Q62), admin-only: an engineer gets the 403 card, an admin the redirect. */
export default async function MachinesPage() {
  await connection();
  const to = machinesRedirect(await currentUser());
  if (!to) return <ForbiddenCard reason="admin" />;
  redirect(to);
}
