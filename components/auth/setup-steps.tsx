"use client";

import { CheckIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import QRCode from "react-qr-code";
import { useState, type ReactNode } from "react";
import { startTotp, verifyTotp } from "@/app/actions/access";
import { finishSetup } from "@/app/actions/members";
import { saveLinearOptIns, saveName } from "@/app/actions/setup";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import type { OptIns, SETUP_STEPS } from "@/lib/opt-ins";
import { cn } from "@/lib/utils";

export type SetupUser = { name: string; email: string; role: "admin" | "engineer"; twoFactorEnabled: boolean; slackMatched: boolean };
type LinearCard = { matched: boolean; note: string };
const STEP_KEYS = ["account", "linear", "done"] as const;
type Step = (typeof STEP_KEYS)[number];

/**
 * /setup (R5, R33, R28): Account saves the name and enrols TOTP, Linear saves the pickup opt-ins,
 * Done stamps setup_done_at and opens Jobs.
 */
export function SetupSteps({ user, steps, linear, optIns: savedOptIns }: { user: SetupUser; steps: typeof SETUP_STEPS; linear: LinearCard; optIns: OptIns }) {
  const [step, setStep] = useState<Step>("account");
  const [name, setName] = useState(user.name);
  const [enrolled, setEnrolled] = useState(user.twoFactorEnabled);
  // Already enrolled means there are no new backup codes to save.
  const [saved, setSaved] = useState(user.twoFactorEnabled);
  const [optIns, setOptIns] = useState(savedOptIns);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const at = STEP_KEYS.indexOf(step);

  return (
    <Card className="w-full max-w-3xl">
      <header className="flex flex-wrap items-center gap-x-5 gap-y-3 border-b px-6 py-4">
        <div className="flex items-center gap-2">
          <span className="grid size-5 place-items-center rounded-[5px] bg-primary text-[11px] font-semibold text-primary-foreground">H</span>
          <b className="font-semibold">Hive</b>
          <span className="text-muted-foreground">setup</span>
        </div>
        <nav aria-label="Setup steps" className="ms-auto flex flex-wrap gap-1">
          {steps.map((label, i) => (
            <StepChip key={label} name={label} n={i + 1} state={i < at ? "done" : i === at ? "current" : "todo"} />
          ))}
        </nav>
      </header>

      <div className="flex min-h-[26rem] flex-col gap-[18px] px-6 pt-7 pb-2">
        {step === "account" ? (
          <Account enrolled={enrolled} name={name} onEnrolled={() => setEnrolled(true)} saved={saved} setSaved={setSaved} setName={setName} user={user} />
        ) : step === "linear" ? (
          <Linear linear={linear} optIns={optIns} pending={pending} setOptIns={setOptIns} />
        ) : (
          <Done name={name} user={user} />
        )}
      </div>

      <footer className="flex flex-wrap items-center gap-2 border-t px-6 py-4">
        {step === "account" ? (
          <>
            <span className="flex-1" />
            <Button disabled={!enrolled || !saved} onClick={() => setStep("linear")}>
              Continue
            </Button>
          </>
        ) : step === "linear" ? (
          <>
            <Button disabled={pending} onClick={() => setStep("account")} variant="ghost">
              Back
            </Button>
            <span className="flex-1" />
            <Failure message={error} />
            <Button
              disabled={pending}
              onClick={async () => {
                setPending(true);
                setError(null);
                try {
                  const result = await saveLinearOptIns(optIns);
                  if (!result.ok) return setError(result.message);
                  setStep("done");
                } catch {
                  setError("Couldn't save your choices. Try again.");
                } finally {
                  setPending(false);
                }
              }}
            >
              {pending ? "Saving" : "Continue"}
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
          state === "current"
            ? "border-foreground bg-foreground text-background"
            : state === "done"
              ? "border-transparent bg-success/12 text-success"
              : "border-border",
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

const firstName = (name: string) => name.trim().split(/\s+/)[0] || "";

function Account({
  user,
  name,
  setName,
  enrolled,
  saved,
  onEnrolled,
  setSaved,
}: {
  user: SetupUser;
  name: string;
  setName: (name: string) => void;
  enrolled: boolean;
  saved: boolean;
  onEnrolled: () => void;
  setSaved: (saved: boolean) => void;
}) {
  const role = ROLE_COPY[user.role];
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">Welcome, {firstName(name) || "there"}</h1>
      <p className="text-sm text-muted-foreground">
        {user.role === "admin"
          ? "You're the first person here, so you're the admin. Check your details, then turn on two-factor authentication."
          : "An admin added you as an engineer. Check your details, then turn on two-factor authentication."}
      </p>
      <Details name={name} setName={setName} user={user} />
      <div className="flex flex-col rounded-xl border">
        <Row
          aside={<Badge variant="secondary">{role.chip}</Badge>}
          mark={user.role === "admin" ? "AD" : "EN"}
          note={role.note}
          title={user.role === "admin" ? "Admin" : "Engineer"}
        />
        <Row
          aside={
            user.slackMatched ? (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <CheckIcon className="size-4 shrink-0" />
                Matched by email
              </span>
            ) : (
              <span className="text-sm text-muted-foreground">Not found in Slack</span>
            )
          }
          mark="SL"
          note="Questions and PRs for you arrive as DMs, with buttons."
          title="Slack"
        />
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

const trimmedName = (name: string) => name.trim();

/** The Account step's own fields (R5): the name is saved to the signed-in user, the email only shown. */
function Details({ user, name, setName }: { user: SetupUser; name: string; setName: (name: string) => void }) {
  const router = useRouter();
  const [saved, setSaved] = useState(trimmedName(user.name));
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [justSaved, setJustSaved] = useState(false);
  const trimmed = trimmedName(name);
  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <Field>
        <FieldLabel htmlFor="setup-name">Name</FieldLabel>
        <div className="flex w-full gap-2">
          <Input
            id="setup-name"
            maxLength={80}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
              setJustSaved(false);
            }}
            value={name}
          />
          <Button
            disabled={pending || trimmed === saved || trimmed.length === 0}
            onClick={async () => {
              setPending(true);
              setError(null);
              const result = await saveName(name);
              setPending(false);
              if (!result.ok) return setError(result.message);
              setSaved(result.name);
              setName(result.name);
              setJustSaved(true);
              router.refresh();
            }}
            size="sm"
            type="button"
            variant="outline"
          >
            {pending ? "Saving" : "Save"}
          </Button>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : (
          <FieldDescription>{justSaved ? "Saved." : "Your name on the jobs you own and in Slack."}</FieldDescription>
        )}
      </Field>
      <Field>
        <FieldLabel htmlFor="setup-email">Email</FieldLabel>
        <Input id="setup-email" readOnly value={user.email} />
        <FieldDescription>The address your invite was sent to.</FieldDescription>
      </Field>
    </div>
  );
}

type Started = { totpURI: string; secret: string; backupCodes: string[] };

/** Password → QR code and secret → a code to check → the backup codes, shown once. */
function Enrolment({
  enrolled,
  onEnrolled,
  saved,
  setSaved,
}: {
  enrolled: boolean;
  onEnrolled: () => void;
  saved: boolean;
  setSaved: (saved: boolean) => void;
}) {
  const [started, setStarted] = useState<Started | null>(null);
  const [verified, setVerified] = useState(false);
  if (started && verified) return <BackupCodes codes={started.backupCodes} saved={saved} setSaved={setSaved} />;
  if (started)
    return (
      <Verify
        started={started}
        onVerified={() => {
          setVerified(true);
          onEnrolled();
        }}
      />
    );
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
      <p className="text-sm">Two-factor authentication is on. Save these backup codes: each works once, and Hive shows them only now.</p>
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
          <Checkbox checked={saved} onCheckedChange={(checked) => setSaved(checked)} />I saved these
        </label>
      </div>
    </div>
  );
}

const hiveLabel = <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hive</code>;

/** The Linear step (R28): an email-matched Linear card and the user's two pickup opt-ins; the label trigger is global. */
function Linear({ linear, optIns, pending, setOptIns }: { linear: LinearCard; optIns: OptIns; pending: boolean; setOptIns: (optIns: OptIns) => void }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">Hand work to Hive</h1>
      <p className="text-sm text-muted-foreground">Link Linear so Hive can pick up issues for you. Nothing runs until you assign or label one.</p>
      <div className="flex flex-col rounded-xl border">
        <Row
          aside={
            linear.matched && (
              <span className="flex items-center gap-1.5 text-sm text-success">
                <CheckIcon className="size-4 shrink-0" />
                Linked
              </span>
            )
          }
          mark="LN"
          note={linear.note}
          title="Linear"
        />
      </div>
      <div className="flex flex-col">
        <OptIn
          checked={optIns.assigned}
          disabled={pending}
          note="Assign an issue to yourself and Hive starts on it, billed to your agents."
          onChange={(assigned) => setOptIns({ ...optIns, assigned })}
          title="Pick up issues assigned to me"
        />
        <OptIn
          checked={optIns.plan_approval}
          disabled={pending}
          note="Plans land in your Inbox. Off means Hive approves plans that cover every requirement."
          onChange={(plan_approval) => setOptIns({ ...optIns, plan_approval })}
          title="Approve plans before code is written"
        />
      </div>
      <p className="text-sm text-muted-foreground">Labelling an issue {hiveLabel} works for anyone, whoever it is assigned to.</p>
    </>
  );
}

function OptIn({
  title,
  note,
  checked,
  disabled,
  onChange,
}: {
  title: string;
  note: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <label className="flex items-center gap-4 border-t py-3 first:border-t-0">
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="font-medium">{title}</span>
        <span className="text-xs text-muted-foreground">{note}</span>
      </span>
      <Switch checked={checked} disabled={disabled} onCheckedChange={onChange} />
    </label>
  );
}

function Done({ user, name }: { user: SetupUser; name: string }) {
  return (
    <>
      <h1 className="text-2xl font-semibold tracking-[-0.015em]">You&apos;re set up</h1>
      <p className="text-sm text-muted-foreground">
        Assign a Linear issue to Hive or label it <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">hive</code>, and it shows up
        under Jobs within a minute.
      </p>
      <div className="flex flex-col rounded-xl border">
        <Row aside={<Badge variant="success">Ready</Badge>} mark="2F" note="Password and an authenticator code" title="Two-factor authentication" />
        <Row
          aside={<Badge variant={user.role === "admin" ? "info" : "outline"}>{user.role === "admin" ? "Admin" : "Engineer"}</Badge>}
          mark={user.role === "admin" ? "AD" : "EN"}
          note={user.email}
          title={name.trim() || user.email}
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
