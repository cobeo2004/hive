"use client";

import { XIcon } from "lucide-react";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveLinearSettings } from "@/app/actions/settings";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import type { LinearSettings } from "@/lib/linear-settings";
import { SettingsSection } from "./settings-section";

/** Settings → Linear (R7a): the teams Hive serves, the pickup label and Hive's Linear user. Read-only for engineers. */
export function LinearSettingsSection({ saved, userName, readOnly = false }: { saved: LinearSettings; userName: string | null; readOnly?: boolean }) {
  const router = useRouter();
  const [teamKeys, setTeamKeys] = useState(saved.teamKeys);
  const [newKey, setNewKey] = useState("");
  const [label, setLabel] = useState(saved.label);
  const [hiveUserId, setHiveUserId] = useState(saved.hiveUserId ?? "");
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [pending, startTransition] = useTransition();
  const edited =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setSavedNow(false);
    };

  const addKey = () => {
    const key = newKey.trim().toUpperCase();
    if (key && !teamKeys.includes(key)) edited(setTeamKeys)([...teamKeys, key]);
    setNewKey("");
  };

  const submit = () => {
    setFailure(null);
    startTransition(async () => {
      const outcome = await saveLinearSettings({ teamKeys, label, hiveUserId: hiveUserId.trim() || null });
      if (!outcome.ok) return setFailure(outcome.message);
      setSavedNow(true);
      router.refresh();
    });
  };

  return (
    <SettingsSection
      id="linear"
      title="Linear"
      description="The Linear teams Hive picks up issues from, the label that hands an issue to Hive, and Hive's own Linear user. One webhook covers every team, so changing teams needs no reinstall."
    >
      <Card>
        <CardContent className="flex flex-col gap-5">
          <Field>
            <FieldLabel>Teams</FieldLabel>
            <ul className="flex flex-wrap gap-2" aria-label="Team keys">
              {teamKeys.map((key) => (
                <li key={key} className="inline-flex items-center gap-1 rounded-md border bg-muted px-2 py-0.5 font-mono text-sm">
                  {key}
                  {!readOnly && (
                    <button
                      type="button"
                      aria-label={`Remove ${key}`}
                      className="text-muted-foreground hover:text-foreground"
                      onClick={() => edited(setTeamKeys)(teamKeys.filter((k) => k !== key))}
                    >
                      <XIcon className="size-3.5" />
                    </button>
                  )}
                </li>
              ))}
            </ul>
            {!readOnly && (
              <div className="flex gap-2">
                <Input
                  aria-label="Add a team key"
                  placeholder="Team key, like MOB"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      addKey();
                    }
                  }}
                  className="w-48"
                />
                <Button variant="outline" onClick={addKey} disabled={!newKey.trim()}>
                  Add
                </Button>
              </div>
            )}
            <FieldDescription>The key in each issue&apos;s identifier, such as MOB in MOB-12.</FieldDescription>
          </Field>
          <div className="grid gap-5 sm:grid-cols-2">
            <Field>
              <FieldLabel htmlFor="linear-label">Pickup label</FieldLabel>
              <Input id="linear-label" value={label} onChange={(e) => edited(setLabel)(e.target.value)} disabled={readOnly} />
              <FieldDescription>An issue in Todo with this label is picked up. It applies to everyone.</FieldDescription>
            </Field>
            <Field>
              <FieldLabel htmlFor="linear-hive-user">Hive&apos;s Linear user</FieldLabel>
              <Input
                id="linear-hive-user"
                placeholder="Linear user id"
                value={hiveUserId}
                onChange={(e) => edited(setHiveUserId)(e.target.value)}
                disabled={readOnly}
              />
              <FieldDescription>{userName ? `Resolves to ${userName}.` : "A Linear user id; its name shows here once Linear resolves it."}</FieldDescription>
            </Field>
          </div>
          {failure && (
            <p role="alert" className="text-sm text-destructive">
              {failure}
            </p>
          )}
        </CardContent>
        {!readOnly && (
          <CardFooter className="gap-3 border-t">
            <Button onClick={submit} disabled={pending || teamKeys.length === 0}>
              {pending && <Spinner data-icon="inline-start" />}
              Save
            </Button>
            {savedNow && <span className="text-sm text-muted-foreground">Saved. The next delivery uses it.</span>}
          </CardFooter>
        )}
      </Card>
    </SettingsSection>
  );
}
