"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { attempt } from "./attempt";

type Credentials = { email: string; password: string };

const MODES = {
  "sign-in": {
    description: "Sign in to Hive. Ask an admin for an invite if you have no account.",
    submit: "Sign in",
    pending: "Signing in",
    passwordAutoComplete: "current-password",
    password: z.string().min(1, "Enter your password"),
    call: (credentials: Credentials) => authClient.signIn.email(credentials),
  },
} as const;

export function CredentialsForm({ mode }: { mode: keyof typeof MODES }) {
  const config = MODES[mode];
  const router = useRouter();
  const [needsCode, setNeedsCode] = useState(false);
  const form = useForm<Credentials>({
    resolver: zodResolver(z.object({ email: z.email("Enter a valid email address"), password: config.password })),
    defaultValues: { email: "", password: "" },
  });

  async function onSubmit(credentials: Credentials) {
    let twoFactor = false;
    const failed = await attempt(async () => {
      const result = await config.call(credentials);
      twoFactor = !!(result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect);
      return result;
    }, `${config.submit} failed`);
    if (failed) {
      form.setError("root", { message: failed.message });
      return;
    }
    // An enrolled user gets no session until the code (R33); one who hasn't enrolled is sent to /setup by the proxy.
    if (twoFactor) setNeedsCode(true);
    else done();
  }

  function done() {
    router.replace("/");
    router.refresh();
  }

  if (needsCode) return <CodeForm onDone={done} />;

  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Hive</CardTitle>
        <CardDescription>{config.description}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={form.handleSubmit(onSubmit)} noValidate>
          <div className="flex flex-col gap-5">
            <Controller
              name="email"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="email">Email</FieldLabel>
                  <Input {...field} id="email" type="email" autoComplete="email" aria-invalid={fieldState.invalid} />
                  {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                </Field>
              )}
            />
            <Controller
              name="password"
              control={form.control}
              render={({ field, fieldState }) => (
                <Field invalid={fieldState.invalid}>
                  <FieldLabel htmlFor="password">Password</FieldLabel>
                  <Input
                    {...field}
                    id="password"
                    type="password"
                    autoComplete={config.passwordAutoComplete}
                    aria-invalid={fieldState.invalid}
                  />
                  {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                </Field>
              )}
            />
            {form.formState.errors.root && (
              <Alert variant="error">
                <AlertTitle>{config.submit} failed</AlertTitle>
                <AlertDescription>{form.formState.errors.root.message}</AlertDescription>
              </Alert>
            )}
            <Button type="submit" disabled={form.formState.isSubmitting}>
              {form.formState.isSubmitting ? config.pending : config.submit}
            </Button>
          </div>
        </form>
      </CardContent>
    </Card>
  );
}

// ponytail: placeholder TOTP step; the designed sign-in replaces it.
function CodeForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const failed = await attempt(
      () => (backup ? authClient.twoFactor.verifyBackupCode({ code }) : authClient.twoFactor.verifyTotp({ code })),
      "That code didn't work",
    );
    if (failed) setError(failed.message);
    else onDone();
  }
  return (
    <Card className="w-full max-w-sm">
      <CardHeader>
        <CardTitle>Hive</CardTitle>
        <CardDescription>{backup ? "Enter one of your backup codes." : "Enter the code from your authenticator app."}</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={submit} className="flex flex-col gap-5">
          <Field>
            <FieldLabel htmlFor="code">{backup ? "Backup code" : "Code"}</FieldLabel>
            <Input id="code" value={code} onChange={(e) => setCode(e.target.value)} autoComplete="one-time-code" />
          </Field>
          {error && (
            <Alert variant="error">
              <AlertDescription>{error}</AlertDescription>
            </Alert>
          )}
          <Button type="submit">Verify</Button>
          <Button type="button" variant="ghost" onClick={() => setBackup(!backup)}>
            {backup ? "Use the authenticator app" : "Use a backup code"}
          </Button>
        </form>
      </CardContent>
    </Card>
  );
}
