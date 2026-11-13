"use client";

import { useRouter } from "next/navigation";
import { type ChangeEvent, type ComponentProps, type FormEvent, useState, useTransition } from "react";
import { addPoolAccount, disconnectPoolAccount, renamePoolAccount } from "@/app/actions/accounts";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import type { MeterAccount } from "@/lib/account-meters";
import type { PoolOutcome } from "@/lib/pool-accounts";
import { SettingsSection } from "./settings-section";
import { MeterBar } from "./usage-meter";

const PROVIDERS = { claude: "Claude", codex: "Codex" };
const NEW = { provider: "claude", label: "", apiKey: "" };
type Props = { accounts: MeterAccount[]; pool: { threshold: number; pauseInstead: boolean }; readOnly?: boolean };

const Btn = ({ text, ...p }: ComponentProps<typeof Button> & { text: string }) => <Button {...p}>{text}</Button>;
const Ghost = (p: ComponentProps<typeof Button>) => <Button size="sm" variant="ghost" {...p} />;
const Labelled = ({ label, id, ...p }: ComponentProps<typeof Input> & { label: string; id: string }) => (
  <Field>
    <FieldLabel htmlFor={id}>{label}</FieldLabel>
    <Input id={id} {...p} />
  </Field>
);

/** Settings → Team pool (R10b): the shared accounts jobs fall back to. Admins add, rename and disconnect; engineers read. The key never comes back out. */
export function TeamPoolSection({ accounts, pool, readOnly = false }: Props) {
  const router = useRouter();
  const [adding, setAdding] = useState<typeof NEW | null>(null);
  const [renaming, setRenaming] = useState<{ id: string; label: string } | null>(null);
  const [disconnecting, setDisconnecting] = useState<MeterAccount | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const run = (action: () => Promise<PoolOutcome>, close: (v: null) => void) => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await action();
      if (!outcome.ok) return setFailure(outcome.message);
      close(null);
      router.refresh();
    });
  };
  const submit = (action: () => Promise<PoolOutcome>, close: (v: null) => void) => (e: FormEvent) => (e.preventDefault(), run(action, close));
  const patchAdd = (p: Partial<typeof NEW>) => adding && setAdding({ ...adding, ...p });
  const alert = failure ? (
    <p role="alert" className="text-sm text-destructive">
      {failure}
    </p>
  ) : null;

  const bind = (k: "label" | "apiKey") => ({ value: adding?.[k] ?? "", onChange: (e: ChangeEvent<HTMLInputElement>) => patchAdd({ [k]: e.target.value }) });

  return (
    <SettingsSection
      id="team-pool"
      title="Team pool"
      description="Shared accounts a job falls back to when its owner's account is rate-limited. Everyone sees the pool; only an admin changes it."
    >
      <Card>
        <CardContent className="flex flex-col gap-4">
          {accounts.length === 0 && <p className="text-sm text-muted-foreground">No pool accounts yet.</p>}
          <ul className="flex flex-col divide-y rounded-lg border empty:hidden">
            {accounts.map((a) => {
              const pct = a.fiveHour?.usedPct ?? null;
              const keyed = a.kind === "api_key";
              return (
                <li key={a.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  {renaming?.id === a.id ? (
                    <form className="flex min-w-0 flex-1 gap-2" onSubmit={submit(() => renamePoolAccount(renaming), setRenaming)}>
                      <Input
                        aria-label={`Rename ${a.label}`}
                        value={renaming.label}
                        onChange={(e) => setRenaming({ ...renaming, label: e.target.value })}
                        autoFocus
                      />
                      <Btn type="submit" size="sm" disabled={pending} text="Save" />
                      <Ghost onClick={() => (setFailure(null), setRenaming(null))}>Cancel</Ghost>
                    </form>
                  ) : (
                    <>
                      <span className="min-w-40 flex-1 break-all font-mono text-sm">{a.label}</span>
                      <span className="text-sm text-muted-foreground">
                        {`${a.provider === "cursor" ? "Cursor" : PROVIDERS[a.provider]} · ${keyed ? "API key" : "Subscription"}${a.ownerId === null ? "" : ` · shared by ${a.ownerName ?? "a teammate"}`}`}
                      </span>
                      {keyed ? (
                        <span className="w-32 text-sm text-muted-foreground">No meter</span>
                      ) : (
                        <span className="flex w-32 items-center gap-2">
                          <MeterBar pct={pct} label={`${a.label} 5-hour window`} className="flex-1" />
                          <span className="text-xs tabular-nums text-muted-foreground">{pct === null ? "—" : `${Math.round(pct)}%`}</span>
                        </span>
                      )}
                      {/* A shared account stays its owner's: only they stop sharing or disconnect it. */}
                      {!readOnly && a.ownerId === null && (
                        <span className="flex gap-1">
                          <Ghost onClick={() => setRenaming({ id: a.id, label: a.label })}>Edit</Ghost>
                          <Ghost onClick={() => setDisconnecting(a)}>Disconnect</Ghost>
                        </span>
                      )}
                    </>
                  )}
                </li>
              );
            })}
          </ul>
          {!readOnly &&
            (adding ? (
              <form className="flex flex-col gap-3 border-t pt-4" onSubmit={submit(() => addPoolAccount(adding), setAdding)}>
                <div className="grid gap-3 sm:grid-cols-[8rem_1fr_1fr]">
                  <Field>
                    <FieldLabel htmlFor="pool-provider">Provider</FieldLabel>
                    <Select items={PROVIDERS} value={adding.provider} onValueChange={(v) => v && patchAdd({ provider: v })}>
                      <SelectTrigger id="pool-provider" className="w-full">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectPopup>
                        <SelectItem value="claude">Claude</SelectItem>
                        <SelectItem value="codex">Codex</SelectItem>
                      </SelectPopup>
                    </Select>
                  </Field>
                  <Labelled id="pool-label" label="Name" placeholder="hive-claude-1" required {...bind("label")} />
                  <Labelled id="pool-key" label="API key" type="password" autoComplete="new-password" required {...bind("apiKey")} />
                </div>
                <div className="flex gap-2">
                  <Btn type="submit" loading={pending} text="Add account" />
                  <Ghost onClick={() => (setFailure(null), setAdding(null))}>Cancel</Ghost>
                </div>
              </form>
            ) : (
              <Btn className="self-start" variant="outline" onClick={() => setAdding(NEW)} text="+ Add account" />
            ))}
          {disconnecting === null && alert}
        </CardContent>
        <CardFooter className="flex-col items-start gap-1 border-t text-sm text-muted-foreground">
          <p>
            Threshold: {pool.threshold}% of the 5-hour window. Pause instead: {pool.pauseInstead ? "On" : "Off"}.
          </p>
          <p>When every pool account is at or above the threshold, a run {pool.pauseInstead ? "pauses" : "keeps falling back"}.</p>
          <p>Both are set in the factory config.</p>
        </CardFooter>
      </Card>
      <AlertDialog open={disconnecting !== null} onOpenChange={(open) => open || pending || setDisconnecting(null)}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {disconnecting?.label}?</AlertDialogTitle>
            <AlertDialogDescription>The key is wiped and the account is never used again. Add it afresh to reconnect.</AlertDialogDescription>
            {disconnecting !== null && alert}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>{"Cancel"}</AlertDialogClose>
            <Btn
              variant="destructive"
              loading={pending}
              onClick={() => disconnecting && run(() => disconnectPoolAccount({ id: disconnecting.id }), setDisconnecting)}
              text="Disconnect"
            />
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </SettingsSection>
  );
}
