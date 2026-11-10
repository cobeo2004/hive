"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { authClient } from "@/lib/auth/client";

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
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>{copy.title}</CardTitle>
        <CardDescription>{copy.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <Button className="w-full" onClick={switchAccount} disabled={pending}>
          {copy.action}
        </Button>
        {failure && (
          <p role="alert" className="mt-3 text-sm text-destructive">
            {failure}
          </p>
        )}
      </CardContent>
    </Card>
  );
}
