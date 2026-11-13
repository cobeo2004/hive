import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { ForbiddenCard } from "@/components/auth/forbidden-card";

export const metadata: Metadata = { title: "Forbidden · Hive" };

/** The 403 page an engineer sees on an admin page (R4). */
export default function ForbiddenPage() {
  return (
    <AuthFrame>
      <ForbiddenCard reason="admin" />
    </AuthFrame>
  );
}
