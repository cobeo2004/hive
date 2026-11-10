"use client";

import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { useState, type ReactNode } from "react";
import { startTotp, verifyTotp } from "@/app/actions/access";
import { finishSetup } from "@/app/actions/members";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

export type SetupUser = { name: string; email: string; role: "admin" | "engineer"; twoFactorEnabled: boolean };

/** /setup (R5, R33): the Account step enrols TOTP, the Done step stamps setup_done_at and opens Jobs. PR4 adds the rest of the design. */
export function SetupSteps({ user }: { user: SetupUser }) {
  const [step, setStep] = useState<"account" | "done">("account");
  const [enrolled, setEnrolled] = useState(user.twoFactorEnabled);
  // Already enrolled means there are no new backup codes to save.
  const [saved, setSaved] = useState(user.twoFactorEnabled);

  return (
    <Card className="w-full max-w-3xl">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="grid size-5 place-items-center rounded-[5px] bg-primary text-[11px] font-semibold text-primary-foreground">H</span>
          <b className="font-semibold">Hive</b>
          <span className="text-muted-foreground">setup</span>
        </div>
        <nav aria-label="Setup steps" className="ms-auto flex flex-wrap gap-1">
          <StepChip name="Account" n={1} state={step === "done" ? "done" : "current"} />
          <StepChip name="Done" n={2} state={step === "done" ? "current" : "todo"} />
        </nav>
      </header>

      <div className="flex min-h-[26rem] flex-col gap-[18px] px-6 pt-7 pb-2">
        {step === "account" ? (
          <Account enrolled={enrolled} onEnrolled={() => setEnrolled(true)} saved={saved} setSaved={setSaved} user={user} />
        ) : (
          <Done user={user} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
        {step === "account" ? (
          <>
            <span className="flex-1" />
            <Button disabled={!enrolled || !saved} onClick={() => setStep("done")}>
              Continue
            </Button>
          </>
        ) : (
          <>
            <span className="flex-1" />
            <FinishTo label="Go to Jobs" pendingLabel="Opening Jobs" to="/" />
          </>
        )}
      </footer>
    </Card>
  );
}

function StepChip({ n, name, state }: { n: number; name: string; state: "todo" | "current" | "done" }) {
  return (
    <span
      aria-current={state === "current" ? "step" : undefined}
      className={cn(
        "inline-flex h-7 items-center gap-1.75 rounded-lg px-2.5 text-xs font-medium",
        state === "current" ? "bg-accent text-foreground" : state === "done" ? "text-foreground" : "text-muted-foreground",
      )}
    >
      <span
        className={cn(
          "grid size-[18px] place-items-center rounded-md border text-[10.5px] font-semibold",
          state === "current" ? "border-foreground bg-foreground text-background" : state === "done" ? "border-transparent bg-success/12 text-success" : "border-border",
        )}
      >
        {state === "done" ? <CheckIcon className="size-3" /> : n}
      </span>
      {name}
    </span>
  );
}

function Row({ mark, title, note, aside }: { mark: string; title: string; note?: string; aside?: ReactNode }) {
  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 border-t px-4 py-3.5 first:border-t-0">
      <span className="grid size-8 place-items-center rounded-[9px] border bg-muted font-mono text-[10.5px] font-bold text-muted-foreground">{mark}</span>
      <span className="flex min-w-0 flex-col">
        <span className="truncate font-semibold">{title}</span>
        {note && <span className="text-xs text-muted-foreground">{note}</span>}
      </span>
      {aside}
    </div>
  );
}

const ROLE_COPY = {
  admin: { note: "Manages connections, the team pool, repositories and workflows.", chip: "First user" },
  engineer: { note: "Works jobs, connects your own agents, reviews PRs.", chip: "Set by an admin" },
} as const;

function Account({ user, enrolled, saved, onEnrolled, setSaved }: { user: SetupUser; enrolled: boolean; saved: boolean; onEnrolled: () => void; setSaved: (saved: boolean) => void }) {
  const role = ROLE_COPY[user.role];
  const initials = user.name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("");
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">Welcome, {user.name.trim().split(/\s+/)[0]}</h1>
      <p className="text-sm text-muted-foreground">
        {user.role === "admin"
          ? "You're the first person here, so you're the admin. Check your details, then turn on two-factor authentication."
          : "An admin added you as an engineer. Check your details, then turn on two-factor authentication."}
      </p>
      <div className="flex flex-col rounded-xl border">
        <Row mark={initials || "ME"} note={user.email} title={user.name} />
        <Row aside={<Badge variant="secondary">{role.chip}</Badge>} mark={user.role === "admin" ? "AD" : "EN"} note={role.note} title={user.role === "admin" ? "Admin" : "Engineer"} />
      </div>
      <div className="flex flex-col gap-4 rounded-xl border bg-muted/40 p-4">
        <div className="flex flex-col gap-1">
          <h2 className="font-semibold">Two-factor authentication</h2>
          <p className="text-sm text-muted-foreground">Every Hive member signs in with a password and a 6-digit code from an authenticator app.</p>
        </div>
        <Enrolment enrolled={enrolled} onEnrolled={onEnrolled} saved={saved} setSaved={setSaved} />
      </div>
    </>
  );
}

type Started = { totpURI: string; secret: string; backupCodes: string[] };

/** Password → QR code and secret → a code to check → the backup codes, shown once. */
function Enrolment({ enrolled, onEnrolled, saved, setSaved }: { enrolled: boolean; onEnrolled: () => void; saved: boolean; setSaved: (saved: boolean) => void }) {
  const [started, setStarted] = useState<Started | null>(null);
  const [verified, setVerified] = useState(false);
  if (started && verified) return <BackupCodes codes={started.backupCodes} saved={saved} setSaved={setSaved} />;
  if (started) return <Verify started={started} onVerified={() => { setVerified(true); onEnrolled(); }} />;
  if (enrolled)
    return (
      <p className="flex items-center gap-2 text-sm">
        <CheckIcon className="size-4 shrink-0 text-success" />
        Two-factor authentication is on.
      </p>
    );
  return <Begin onStarted={setStarted} />;
}

function Begin({ onStarted }: { onStarted: (started: Started) => void }) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={async (event) => {
        event.preventDefault();
        setPending(true);
        setError(null);
        const result = await startTotp(password);
        setPending(false);
        if (result.ok) onStarted({ totpURI: result.totpURI, secret: result.secret, backupCodes: result.backupCodes });
        else setError(result.message);
      }}
    >
      <Field>
        <FieldLabel htmlFor="totp-password">Password</FieldLabel>
        <Input autoComplete="current-password" id="totp-password" onChange={(event) => setPassword(event.target.value)} type="password" value={password} />
        <FieldDescription>Your current password, to start enrolment.</FieldDescription>
      </Field>
      <Failure message={error} />
      <Button className="self-start" disabled={pending} type="submit">
        {pending ? "Starting" : "Set up two-factor authentication"}
      </Button>
    </form>
  );
}

function Verify({ started, onVerified }: { started: Started; onVerified: () => void }) {
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  return (
    <div className="grid gap-4 sm:grid-cols-[auto_minmax(0,1fr)]">
      <div className="w-fit rounded-lg bg-white p-3">
        <QRCode level="M" size={132} title="Authenticator setup QR code" value={started.totpURI} />
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <p className="text-sm text-muted-foreground">Scan it with your authenticator app, or type the secret in by hand.</p>
        <div className="flex items-center gap-2">
          <code className="min-w-0 flex-1 rounded-lg border bg-muted/50 px-3 py-2 font-mono text-xs break-all">{started.secret}</code>
          <CopyButton label="Copy the secret" value={started.secret} />
        </div>
        <form
          className="flex flex-col gap-3"
          onSubmit={async (event) => {
            event.preventDefault();
            setPending(true);
            setError(null);
            const result = await verifyTotp(code.trim());
            setPending(false);
            if (result.ok) onVerified();
            else setError(result.message);
          }}
        >
          <Field>
            <FieldLabel htmlFor="totp-code">Code</FieldLabel>
            <Input
              autoComplete="one-time-code"
              className="w-32 font-mono tracking-[0.2em]"
              id="totp-code"
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setCode(event.target.value)}
              value={code}
            />
          </Field>
          <Failure message={error} />
          <Button className="self-start" disabled={pending} size="sm" type="submit">
            {pending ? "Checking" : "Verify and turn on"}
          </Button>
        </form>
      </div>
    </div>
  );
}

function BackupCodes({ codes, saved, setSaved }: { codes: string[]; saved: boolean; setSaved: (saved: boolean) => void }) {
  return (
    <div className="flex flex-col gap-4">
      <p className="text-sm">
        Two-factor authentication is on. Save these backup codes: each works once, and Hive shows them only now.
      </p>
      <div className="grid grid-cols-2 gap-x-6 gap-y-1 rounded-lg border bg-muted/50 p-4 font-mono text-sm">
        {codes.map((code) => (
          <span key={code}>{code}</span>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <CopyButton label="Copy the backup codes" value={codes.join("\n")}>
          Copy
        </CopyButton>
        <label className="flex items-center gap-2 text-sm">
          <Checkbox checked={saved} onCheckedChange={(checked) => setSaved(checked)} />
          I saved these
        </label>
      </div>
    </div>
  );
}

function Done({ user }: { user: SetupUser }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">You&apos;re set up</h1>
      <p className="text-sm text-muted-foreground">
        Assign a Linear issue to Hive or label it <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hive</code>, and it shows up under Jobs
        within a minute.
      </p>
      <div className="flex flex-col rounded-xl border">
        <Row aside={<Badge variant="success">Ready</Badge>} mark="2F" note="Password and an authenticator code" title="Two-factor authentication" />
        <Row
          aside={<Badge variant={user.role === "admin" ? "info" : "outline"}>{user.role === "admin" ? "Admin" : "Engineer"}</Badge>}
          mark={user.role === "admin" ? "AD" : "EN"}
          note={user.email}
          title={user.name}
        />
      </div>
      {user.role === "admin" && (
        <div className="flex flex-wrap items-center gap-3 rounded-xl border bg-muted/40 px-4 py-3">
          <span className="flex-1 basis-80 text-sm text-muted-foreground">
            As the admin, connect GitHub and add your first repository next: Hive onboards it and opens a PR with the recipe.
          </span>
          <FinishTo label="Add a repository" pendingLabel="Opening Repositories" to="/repositories" variant="outline" />
        </div>
      )}
    </>
  );
}

/** Finishing setup comes first: until setup_done_at is set, the proxy sends every other page back to /setup. */
function FinishTo({ label, pendingLabel, to, variant }: { label: string; pendingLabel: string; to: string; variant?: "outline" }) {
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <>
      <Failure message={error} />
      <Button
        disabled={pending}
        onClick={async () => {
          setPending(true);
          setError(null);
          const result = await finishSetup();
          setPending(false);
          if (!result.ok) return setError(result.message);
          router.replace(to);
          router.refresh();
        }}
        variant={variant}
      >
        {pending ? pendingLabel : label}
      </Button>
    </>
  );
}

function Failure({ message }: { message: string | null }) {
  if (!message) return null;
  return (
    <p role="alert" className="text-sm text-destructive">
      {message}
    </p>
  );
}
