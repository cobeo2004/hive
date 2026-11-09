"use client";

import { useRouter } from "next/navigation";
import { useState, type ReactNode } from "react";
import { acceptInviteLink, acceptSetupLink, resetPassword } from "@/app/actions/access";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";

type Result = { ok: true } | { ok: false; message: string };

/** The frame the three link pages share: one card in the middle of the page. */
export function AuthShell({ title, description, children }: { title: string; description: ReactNode; children: ReactNode }) {
  return (
    <main className="flex min-h-svh items-center justify-center p-6">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent>{children}</CardContent>
      </Card>
    </main>
  );
}

/** A token that is spent, expired or made under other rules (R32); the page shows it where the form would go. */
export const INVALID_LINK = "This link is invalid or used.";

type LinkField = {
  name: string;
  label: string;
  type?: "text" | "email" | "password";
  autoComplete?: string;
  hint?: string;
  value?: string;
  readOnly?: boolean;
};

function LinkForm({ fields, submitLabel, submit, onDone }: { fields: readonly LinkField[]; submitLabel: string; submit: (values: Record<string, string>) => Promise<Result>; onDone: () => void }) {
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(fields.map((field) => [field.name, field.value ?? ""])));
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  return (
    <form
      className="flex flex-col gap-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await submit(values);
        setPending(false);
        if (result.ok) onDone();
        else setError(result.message);
      }}
    >
      {fields.map((field) => (
        <Field key={field.name}>
          <FieldLabel htmlFor={field.name}>{field.label}</FieldLabel>
          <Input
            autoComplete={field.autoComplete}
            id={field.name}
            name={field.name}
            onChange={(event) => setValues((current) => ({ ...current, [field.name]: event.target.value }))}
            readOnly={field.readOnly}
            required={!field.readOnly}
            type={field.type ?? "text"}
            value={values[field.name]}
          />
          {field.hint && <FieldDescription>{field.hint}</FieldDescription>}
        </Field>
      ))}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
      <Button type="submit" disabled={pending}>
        {pending ? "Saving" : submitLabel}
      </Button>
    </form>
  );
}

const PASSWORD: LinkField = { name: "password", label: "Password", type: "password", autoComplete: "new-password", hint: "At least 8 characters." };

/** The first admin, from a setup link (R32). Its email comes from the link and can still be corrected. */
export function SetupLinkForm({ token }: { token: string }) {
  const router = useRouter();
  return (
    <LinkForm
      fields={[{ name: "name", label: "Name", autoComplete: "name" }, { name: "email", label: "Email", type: "email", autoComplete: "email" }, PASSWORD]}
      onDone={() => {
        router.replace("/setup");
        router.refresh();
      }}
      submit={(values) => acceptSetupLink(token, { name: values.name, email: values.email, password: values.password })}
      submitLabel="Create the admin account"
    />
  );
}

/** An invited engineer, from an invite link (R32): the email is the one the invite was made for. */
export function InviteForm({ token, email }: { token: string; email: string }) {
  const router = useRouter();
  return (
    <LinkForm
      fields={[{ name: "name", label: "Name", autoComplete: "name" }, { name: "email", label: "Email", value: email, readOnly: true }, PASSWORD]}
      onDone={() => {
        router.replace("/setup");
        router.refresh();
      }}
      submit={(values) => acceptInviteLink(token, { name: values.name, password: values.password })}
      submitLabel="Create my account"
    />
  );
}

/** A new password from a reset link (R32); it signs no one in, so the page goes back to sign-in. */
export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  return (
    <LinkForm
      fields={[PASSWORD]}
      onDone={() => router.replace("/auth/sign-in")}
      submit={(values) => resetPassword(token, { password: values.password })}
      submitLabel="Set the new password"
    />
  );
}
