"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Controller, useForm } from "react-hook-form";
import { z } from "zod";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Field, FieldDescription, FieldError, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { authClient } from "@/lib/auth/client";
import { AuthHeading } from "./auth-frame";
import { attempt } from "./attempt";

const credentials = z.object({ email: z.email("Enter a valid email address"), password: z.string().min(1, "Enter your password") });
type Credentials = z.infer<typeof credentials>;

/** Sign-in (R3): a password, then the authenticator code or one backup code. Accounts come only from an invite. */
export function CredentialsForm() {
  const router = useRouter();
  const [needsCode, setNeedsCode] = useState(false);
  const form = useForm<Credentials>({ resolver: zodResolver(credentials), defaultValues: { email: "", password: "" } });

  function done() {
    router.replace("/");
    router.refresh();
  }

  async function onSubmit(values: Credentials) {
    let twoFactor = false;
    const failed = await attempt(async () => {
      const result = await authClient.signIn.email(values);
      twoFactor = !!(result.data && "twoFactorRedirect" in result.data && result.data.twoFactorRedirect);
      return result;
    }, "Sign-in failed");
    if (failed) {
      form.setError("root", { message: failed.message });
      return;
    }
    // An enrolled user has no session until the code (R33); one who hasn't enrolled is sent to /setup by the proxy.
    if (twoFactor) setNeedsCode(true);
    else done();
  }

  return (
    <>
      {needsCode ? (
        <CodeForm onDone={done} />
      ) : (
        <>
          <AuthHeading description="Hive, Unibuz's software factory." title="Sign in to Hive" />
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
                    <Input {...field} id="password" type="password" autoComplete="current-password" aria-invalid={fieldState.invalid} />
                    {fieldState.error && <FieldError match>{fieldState.error.message}</FieldError>}
                  </Field>
                )}
              />
              {form.formState.errors.root && (
                <Alert variant="error">
                  <AlertTitle>Sign-in failed</AlertTitle>
                  <AlertDescription>{form.formState.errors.root.message}</AlertDescription>
                </Alert>
              )}
              <Button className="w-full" size="lg" type="submit" disabled={form.formState.isSubmitting}>
                {form.formState.isSubmitting ? "Signing in" : "Sign in"}
              </Button>
            </div>
          </form>
        </>
      )}
      <p className="text-xs text-muted-foreground">No account? Ask an admin for an invite.</p>
    </>
  );
}

/** The second step: the current code from the authenticator app, or one of the backup codes shown when TOTP was enrolled. */
function CodeForm({ onDone }: { onDone: () => void }) {
  const [code, setCode] = useState("");
  const [backup, setBackup] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function submit(event: React.FormEvent) {
    event.preventDefault();
    const entered = code.trim();
    if (!backup && !/^\d{6}$/.test(entered)) {
      setError("Enter the 6-digit code.");
      return;
    }
    if (!entered) {
      setError("Enter a backup code.");
      return;
    }
    setPending(true);
    setError(null);
    const failed = await attempt(
      () => (backup ? authClient.twoFactor.verifyBackupCode({ code: entered }) : authClient.twoFactor.verifyTotp({ code: entered })),
      "That code didn't work",
    );
    setPending(false);
    if (failed) setError(failed.message);
    else onDone();
  }

  return (
    <>
      <AuthHeading
        description={backup ? "Enter one of the backup codes you saved." : "Enter the 6-digit code from your authenticator app."}
        title="Two-factor authentication"
      />
      <form onSubmit={submit} className="flex flex-col gap-5">
        <Field invalid={!!error}>
          <FieldLabel htmlFor="code">{backup ? "Backup code" : "Code"}</FieldLabel>
          <Input
            autoComplete="one-time-code"
            className="font-mono tracking-[0.2em]"
            id="code"
            inputMode={backup ? "text" : "numeric"}
            maxLength={backup ? undefined : 6}
            onChange={(event) => setCode(event.target.value)}
            value={code}
          />
          <FieldDescription>A backup code works once.</FieldDescription>
        </Field>
        {error && (
          <Alert variant="error">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button className="w-full" size="lg" type="submit" disabled={pending}>
          {pending ? "Checking" : "Verify"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          onClick={() => {
            setBackup(!backup);
            setCode("");
            setError(null);
          }}
        >
          {backup ? "Use an authenticator code" : "Use a backup code"}
        </Button>
      </form>
    </>
  );
}
