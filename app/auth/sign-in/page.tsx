import type { Metadata } from "next";
import { AuthFrame } from "@/components/auth/auth-frame";
import { CredentialsForm } from "@/components/auth/credentials-form";

export const metadata: Metadata = { title: "Sign in · Hive" };

export default function SignInPage() {
  return (
    <AuthFrame>
      <CredentialsForm />
    </AuthFrame>
  );
}
