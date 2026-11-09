"use client";

// ponytail: plain placeholder forms so the flows run end to end; the designed pages replace them.
import { useRouter } from "next/navigation";
import { useState } from "react";
import { acceptInviteLink, acceptSetupLink, resetPassword, startTotp, verifyTotp } from "@/app/actions/access";
import { finishSetup } from "@/app/actions/members";

type Result = { ok: true } | { ok: false; message: string };

function Form({ fields, submit, onDone, label }: { fields: string[]; submit: (values: Record<string, string>) => Promise<Result>; onDone: () => void; label: string }) {
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex w-full max-w-sm flex-col gap-3"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        const result = await submit(Object.fromEntries(new FormData(event.currentTarget)) as Record<string, string>);
        setPending(false);
        if (result.ok) onDone();
        else setError(result.message);
      }}
    >
      {fields.map((name) => (
        <label key={name} className="flex flex-col gap-1 text-sm">
          {name}
          <input name={name} type={name === "password" ? "password" : name === "email" ? "email" : "text"} required className="rounded border px-2 py-1" />
        </label>
      ))}
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <button type="submit" disabled={pending} className="rounded border px-3 py-1">
        {label}
      </button>
    </form>
  );
}

export function SetupLinkForm({ token }: { token: string }) {
  const router = useRouter();
  return <Form fields={["name", "email", "password"]} label="Create the admin account" submit={(v) => acceptSetupLink(token, { name: v.name!, email: v.email!, password: v.password! })} onDone={() => router.replace("/setup")} />;
}

export function InviteForm({ token }: { token: string }) {
  const router = useRouter();
  return <Form fields={["name", "password"]} label="Create my account" submit={(v) => acceptInviteLink(token, { name: v.name!, password: v.password! })} onDone={() => router.replace("/setup")} />;
}

export function ResetForm({ token }: { token: string }) {
  const router = useRouter();
  return <Form fields={["password"]} label="Set the new password" submit={(v) => resetPassword(token, { password: v.password! })} onDone={() => router.replace("/auth/sign-in")} />;
}

export function SetupSteps({ enrolled }: { enrolled: boolean }) {
  const router = useRouter();
  const [totp, setTotp] = useState<{ totpURI: string; secret: string; backupCodes: string[] } | null>(null);
  const [done, setDone] = useState(enrolled);
  if (done) return <Form fields={[]} label="Done" submit={finishSetup} onDone={() => router.replace("/")} />;
  if (!totp)
    return (
      <Form
        fields={["password"]}
        label="Set up two-factor authentication"
        submit={async (v) => {
          const started = await startTotp(v.password!);
          if (started.ok) setTotp(started);
          return started.ok ? { ok: false, message: "" } : started;
        }}
        onDone={() => {}}
      />
    );
  return (
    <div className="flex flex-col gap-3">
      <p className="break-all font-mono text-xs">{totp.totpURI}</p>
      <p>Secret: <code>{totp.secret}</code></p>
      <p>Backup codes (shown once):</p>
      <pre className="text-xs">{totp.backupCodes.join("\n")}</pre>
      <Form fields={["code"]} label="Verify" submit={(v) => verifyTotp(v.code!)} onDone={() => setDone(true)} />
    </div>
  );
}
