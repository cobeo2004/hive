"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { accountLogin, cancelAccountLogin, disconnectMyAccount, shareMyAccount, startAccountLogin, submitLoginCode } from "@/app/actions/accounts";
import { CopyButton } from "@/components/copy-button";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { MeterAccount, Reading } from "@/lib/account-meters";
import { MeterBar } from "./usage-meter";

type Provider = "claude" | "codex";
type Login = Awaited<ReturnType<typeof accountLogin>>;
const HARNESS = {
  claude: { title: "Claude", note: "Your Claude subscription, used by Claude Code", hint: "Open the link, sign in, then paste the code Claude shows you." },
  codex: { title: "ChatGPT", note: "Your ChatGPT subscription, used by Codex", hint: "Open the link, sign in and enter this code." },
} as const;

/** Your accounts (R27, R27c): one card per harness, in Settings (`manage` adds Reconnect and Disconnect) and in setup's Agents step. No token reaches the browser. */
export function YourAccounts({ accounts, manage = false }: { accounts: MeterAccount[]; manage?: boolean }) {
  return (
    <div className="grid grid-cols-[repeat(auto-fit,minmax(260px,1fr))] gap-3">
      {(["claude", "codex"] as const).map((p) => (
        <AccountCard key={p} provider={p} manage={manage} account={accounts.find((a) => a.provider === p && a.kind === "subscription")} />
      ))}
    </div>
  );
}

function Meter({ label, reading, title }: { label: string; reading: Reading | null; title: string }) {
  // ponytail: no reading (the usage endpoint can't read subscriptions yet) hides the meter instead of showing an error.
  if (!reading) return null;
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex justify-between text-xs text-muted-foreground">
        <span>{label}</span>
        <span className="tabular-nums">{Math.round(reading.usedPct)}%</span>
      </div>
      <MeterBar pct={reading.usedPct} label={`${title} ${label}`} />
    </div>
  );
}

function AccountCard({ provider, account, manage }: { provider: Provider; account?: MeterAccount; manage: boolean }) {
  const router = useRouter();
  const { title, note, hint } = HARNESS[provider];
  const [loginId, setLoginId] = useState<string | null>(null);
  const [login, setLogin] = useState<Login | null>(null);
  const [pasted, setPasted] = useState("");
  const [checking, setChecking] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  // The runner fills the row with the link and code, and deletes it when the login ends; the account list then says how it went.
  useEffect(() => {
    if (!loginId) return;
    let live = true;
    const poll = () =>
      accountLogin(loginId).then(
        (row) => {
          if (!live) return;
          if (row) {
            setLogin(row);
            // A failed row stays until it expires; "Try again" starts a new login, so stop asking.
            if (row.status === "failed") clearInterval(timer);
            return;
          }
          setLoginId(null);
          router.refresh();
        },
        () => {},
      );
    const timer = setInterval(poll, 2000);
    poll();
    return () => {
      live = false;
      clearInterval(timer);
    };
  }, [loginId, router]);

  const act = (fn: () => Promise<unknown>) => {
    setError(null);
    startTransition(async () => {
      try {
        await fn();
      } catch {
        setError("Something went wrong. Try again.");
      }
    });
  };
  const connect = () =>
    act(async () => {
      setLogin(null);
      setPasted("");
      setChecking(false);
      setLoginId((await startAccountLogin(provider)).loginId);
    });
  const cancel = () =>
    act(async () => {
      if (loginId) await cancelAccountLogin(loginId);
      setLoginId(null);
    });
  const signedIn = () =>
    act(async () => {
      if (provider === "claude" && loginId && !(await submitLoginCode(loginId, pasted))) return setError("That code wasn't accepted. Check it and try again.");
      setChecking(true);
    });
  const disconnect = () =>
    act(async () => {
      const outcome = account && (await disconnectMyAccount(account.id));
      if (outcome && !outcome.ok) return setError(outcome.message);
      setConfirming(false);
      router.refresh();
    });
  const share = (shared: boolean) =>
    act(async () => {
      const outcome = account && (await shareMyAccount(account.id, shared));
      if (outcome && !outcome.ok) return setError(outcome.message);
      router.refresh();
    });

  const waiting = loginId && login?.status === "waiting_code" && login.url;
  return (
    <div className="flex flex-col gap-2.5 rounded-[10px] bg-(--surface-2) p-3.5">
      <div className="flex items-center justify-between gap-2">
        <b className="font-semibold">{title}</b>
        {account ? <Badge variant="success">Signed in</Badge> : <Badge variant="outline">Team pool</Badge>}
      </div>
      <span className="text-xs text-muted-foreground">{note}</span>
      {loginId ? (
        waiting ? (
          <div className="flex flex-col gap-2">
            <span className="text-sm">{hint}</span>
            {login.code && (
              <div className="flex items-center gap-2">
                <code className="rounded-lg border bg-background px-3 py-1.5 font-mono text-sm tracking-widest">{login.code}</code>
                <CopyButton label="Copy the code" value={login.code}>
                  Copy
                </CopyButton>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" render={<a href={login.url ?? undefined} target="_blank" rel="noreferrer" />}>
                Open
              </Button>
              <CopyButton label="Copy the link" value={login.url ?? ""}>
                Copy link
              </CopyButton>
            </div>
            {provider === "claude" && (
              <Input aria-label="Code from Claude" placeholder="Paste the code from Claude" value={pasted} onChange={(e) => setPasted(e.target.value)} />
            )}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" loading={pending} disabled={checking || (provider === "claude" && !pasted.trim())} onClick={signedIn}>
                I&apos;ve signed in
              </Button>
              <Button size="sm" variant="ghost" onClick={cancel}>
                Cancel
              </Button>
              {checking && (
                <span role="status" className="text-xs text-muted-foreground">
                  Finishing sign-in…
                </span>
              )}
            </div>
          </div>
        ) : login?.status === "failed" ? (
          <div className="flex flex-wrap items-center gap-2">
            <span role="status" className="text-sm text-destructive">
              Sign-in failed.
            </span>
            <Button size="sm" variant="secondary" onClick={connect}>
              Try again
            </Button>
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </div>
        ) : (
          <span role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner className="size-4" />
            Starting sign-in on a runner…
            <Button size="sm" variant="ghost" onClick={cancel}>
              Cancel
            </Button>
          </span>
        )
      ) : account ? (
        <>
          <Meter label="5-hour window" reading={account.fiveHour} title={title} />
          <Meter label="Weekly" reading={account.weekly} title={title} />
          {manage && (
            <label className="flex items-start justify-between gap-3 text-sm">
              <span className="flex flex-col gap-0.5">
                <span>Share with the team pool</span>
                <span className="text-xs text-muted-foreground">
                  Teammates without their own {title} account can run their jobs on it. Turning it off stops new jobs; ones already on it finish.
                </span>
              </span>
              <Switch checked={account.shared} disabled={pending} onCheckedChange={share} />
            </label>
          )}
          {manage &&
            (confirming ? (
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm">Disconnect {title}? Your jobs fall back to the team pool.</span>
                <Button size="sm" variant="destructive" loading={pending} onClick={disconnect}>
                  Disconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(false)}>
                  Keep
                </Button>
              </div>
            ) : (
              <div className="flex gap-2">
                <Button size="sm" variant="secondary" loading={pending} onClick={connect}>
                  Reconnect
                </Button>
                <Button size="sm" variant="ghost" onClick={() => setConfirming(true)}>
                  Disconnect
                </Button>
              </div>
            ))}
        </>
      ) : (
        <Button className="self-start" size="sm" variant="secondary" loading={pending} onClick={connect}>
          Connect
        </Button>
      )}
      {error && (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
