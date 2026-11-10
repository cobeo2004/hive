import type { Metadata } from "next";
import { ForbiddenCard } from "@/components/auth/forbidden-card";

export const metadata: Metadata = { title: "Forbidden · Hive" };

/** The 403 page an engineer sees on an admin page (R4). */
export default function ForbiddenPage() {
  return (
    <main className="flex min-h-screen items-center justify-center p-6">
      <ForbiddenCard reason="admin" />
    </main>
  );
}
