"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { AuthHeading } from "./auth-frame";

const COPY = {
  admin: {
    title: "Admins only",
    description: "This page is for Hive admins. Ask an admin if you need it.",
    action: "Sign in with another account",
  },
} as const;

export function ForbiddenCard({ reason }: { reason: keyof typeof COPY }) {
  const copy = COPY[reason];
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);

  async function switchAccount() {
    setPending(true);
    setFailure(null);
    try {
      await authClient.signOut();
      router.replace("/auth/sign-in");
    } catch (error) {
      setFailure(error instanceof Error ? error.message : "Sign-out failed");
      setPending(false);
    }
  }

  return (
    <>
      <AuthHeading description={copy.description} title={copy.title} />
      <Button className="w-full" onClick={switchAccount} disabled={pending} size="lg">
        {copy.action}
      </Button>
      {failure && (
        <p role="alert" className="text-sm text-destructive">
          {failure}
        </p>
      )}
    </>
  );
}
