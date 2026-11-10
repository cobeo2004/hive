import type { Metadata } from "next";
import { CredentialsForm } from "@/components/auth/credentials-form";

export const metadata: Metadata = { title: "Sign in · Hive" };

export default function SignInPage() {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <CredentialsForm />
    </main>
  );
}
