"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { saveJobSources } from "@/app/actions/settings";
import { SourceChoiceField } from "@/components/source-choice-field";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Spinner } from "@/components/ui/spinner";
import type { SourceChoice } from "@/lib/source-choice";
import { SettingsSection } from "./settings-section";

/** Settings → Job sources (R13): where jobs come from. Choosing GitHub Issues alone hides Linear's section (R14); turning GitHub on creates its labels (R15). */
export function JobSourcesSection({ saved, forced = false }: { saved: SourceChoice; forced?: boolean }) {
  const router = useRouter();
  const [choice, setChoice] = useState(saved);
  const [failure, setFailure] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const submit = () => {
    setFailure(null);
    setNote(null);
    startTransition(async () => {
      const outcome = await saveJobSources(choice);
      if (!outcome.ok) return setFailure(outcome.message);
      setNote(outcome.labelNote ?? "Saved.");
      router.refresh();
    });
  };

  return (
    <SettingsSection
      id="job-sources"
      title="Job sources"
      description="Where jobs come from. GitHub Issues alone needs no Linear key, and its Linear settings are hidden. Switching GitHub Issues on creates the Hive labels in every enabled repository."
    >
      <Card>
        <CardContent>
          <SourceChoiceField disabled={pending} onChange={setChoice} value={choice} />
          {forced && (
            <p className="mt-4 text-sm text-muted-foreground">
              GitHub Issues is also on: <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs text-foreground">FACTORY_GITHUB_ISSUES=on</code> forces
              it on, whatever is chosen here.
            </p>
          )}
          {failure && (
            <p role="alert" className="mt-4 text-sm text-destructive">
              {failure}
            </p>
          )}
        </CardContent>
        <CardFooter className="gap-3 border-t">
          <Button disabled={pending || choice === saved} onClick={submit}>
            {pending && <Spinner data-icon="inline-start" />}
            Save
          </Button>
          {note && <span className="text-sm text-muted-foreground">{note}</span>}
        </CardFooter>
      </Card>
    </SettingsSection>
  );
}
