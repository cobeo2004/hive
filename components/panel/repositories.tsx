"use client";

import { ExternalLinkIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, useTransition } from "react";
import { makeDefaultRepository, saveRepository } from "@/app/actions/repositories";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from "@/components/ui/empty";
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import type { MachineRow, RepoSettingsRow } from "@/db/schema";
import { EXECUTIONS, type Execution } from "@/lib/execution";
import type { Harness } from "@/lib/harness";
import { parseInventory, rebuildText, reportedDrift, reportedHarnesses, reportedSandbox, sandboxLogin, UNKNOWN } from "@/lib/machine";
import { AUTONOMY_LABELS, AUTONOMY_LEVELS, type Autonomy } from "@/lib/merge-decision";
import { repoImage } from "@/lib/onboarding";
import { displayName } from "@/lib/repo-name";
import type { RepoStats } from "@/lib/repositories";
import { RUNS_ON_LABELS } from "@/lib/ticket-overrides";
import { cn } from "@/lib/utils";
import { useRowKeys } from "./row-keys";
import { useFeed, type Feed } from "./live-refresh";
import { PanelFooter, PanelHeader, type KeyHint } from "./panel-header";
import { AddRepository, OnboardingBadge, OnboardingSection, OnboardingSide, onboardingLine, PANEL, useOnboardingRefresh } from "./repo-onboarding";
import { useNow } from "./time";

const CLOCK_TICK_MS = 30_000;

const AUTONOMY_HELP: Record<Autonomy, string> = {
  off: "Every pull request is ready for your review. The factory evaluates nothing.",
  trial: "The factory evaluates each pull request and shows whether it would merge or why it hands over, but never merges.",
  auto: "The factory merges a pull request it is confident about and every hard limit holds: checks green, no conflicts, Bugbot clear, and verified at its head.",
};

const LIST_KEYS: readonly KeyHint[] = [
  { keys: ["J", "K"], label: "move" },
  { keys: ["↵"], label: "open" },
];

const SETTINGS_DEFAULT = "settings-default";

const itemHref = (repo: string) => `/repositories?${new URLSearchParams({ repo })}`;
const githubUrl = (repo: string) => `https://github.com/${repo}`;
/** The repo's Workflow page (Q41); the segment is the encoded `owner/name`. */
export const workflowHref = (repo: string) => `/repositories/${encodeURIComponent(repo)}/workflow`;

/**
 * Where a repo's jobs can launch. Modal needs a runner that can launch there and, for an onboarded
 * repo, its warm image, or the base image while the warm one is outdated; a local launch needs a
 * runner's checkout.
 */
type Places = { modal: boolean; modalNote: string | null; machines: string[]; rebuild?: string };

function placesOf(rows: readonly MachineRow[], now: number, row: RepoSettingsRow): Places {
  const sandbox = reportedSandbox(rows, now);
  const drift = sandbox ? reportedDrift(sandbox) : [];
  const runner = Boolean(sandbox && sandbox.modal && sandbox.image && drift.length === 0 && sandboxLogin(sandbox));
  const info = sandbox?.imageInfo;
  const image = repoImage(row, info?.versions ? { versions: info.versions, builtAt: info.builtAt } : null);
  const machines = rows.filter((m) => parseInventory(m.inventory)?.repos.some((r) => r.origin !== UNKNOWN && r.origin === row.repo)).map((m) => m.name);
  const modalNote = (() => {
    switch (image.kind) {
      case "warm":
        return "Warm cloud sandbox image ready";
      case "base":
        return image.outdated ? "Cloud sandboxes start from the base image until the warm one is rebuilt" : "Cloud sandbox image ready";
      case "blocked":
        return null;
      default: {
        const never: never = image;
        throw new Error(`unknown image ${String(never)}`);
      }
    }
  })();
  return { modal: runner && image.kind !== "blocked", modalNote, machines, ...(drift.length > 0 && { rebuild: rebuildText(drift) }) };
}

function placesLine({ modal, modalNote, machines, rebuild }: Places) {
  const parts = [modal && modalNote, rebuild, machines.length > 0 && `Local checkout on ${machines.join(", ")}`].filter(Boolean);
  return parts.length > 0 ? parts.join(" · ") : "Neither a cloud sandbox image nor a local checkout";
}

type Entry = { row: RepoSettingsRow; stats: RepoStats | undefined; places: Places };

function StateBadge({ row }: { row: RepoSettingsRow }) {
  if (row.enabled && row.onboarding_state) return <OnboardingBadge state={row.onboarding_state} />;
  return (
    <Badge variant="outline" size="sm">
      {row.enabled ? "Not onboarded" : "Disabled"}
    </Badge>
  );
}

/** A repo card (the canvas's .rp): name and state, then how it runs, or where onboarding stands. */
function Row({ entry, open, cursor, onFocus }: { entry: Entry; open: boolean; cursor: boolean; onFocus: () => void }) {
  const { row, stats, places } = entry;
  const nowhere = !places.modal && places.machines.length === 0;
  const runs = [row.execution ? RUNS_ON_LABELS[row.execution] : "Settings default", `${stats?.open ?? 0} open`, AUTONOMY_LABELS[row.autonomy]];
  return (
    <div
      className={cn(
        "relative grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-2.5 gap-y-1 rounded-2xl border-[1.5px] border-transparent p-3.5 transition-colors duration-150 hover:bg-accent",
        open ? "border-primary bg-[var(--primary-soft)] hover:bg-[var(--primary-soft)]" : cursor && "bg-accent",
        !row.enabled && "text-muted-foreground",
      )}
    >
      <Link
        href={itemHref(row.repo)}
        scroll={false}
        data-row={row.repo}
        onFocus={onFocus}
        aria-current={open ? "true" : undefined}
        aria-label={`Open ${displayName(row)}`}
        className="absolute inset-0 rounded-2xl outline-none focus-visible:ring-2 focus-visible:ring-ring"
      />
      <span className="truncate font-mono text-[13px] font-semibold">{displayName(row)}</span>
      <StateBadge row={row} />
      <span
        className={cn(
          "col-span-2 truncate text-xs",
          nowhere || row.onboarding_state === "failed" || row.onboarding_state === "needs_input" ? "text-warning" : "text-muted-foreground",
        )}
      >
        {row.onboarding_state && row.onboarding_state !== "ready" ? onboardingLine(row) : nowhere ? placesLine(places) : runs.join(" · ")}
      </span>
    </div>
  );
}

function Detail({
  entry,
  harnesses,
  panelTakesSecrets,
  canEdit,
}: {
  entry: Entry;
  harnesses: readonly Harness[];
  panelTakesSecrets: boolean;
  canEdit: boolean;
}) {
  const router = useRouter();
  const { row, stats, places } = entry;
  const [name, setName] = useState(displayName(row));
  const [enabled, setEnabled] = useState(row.enabled);
  const [provider, setProvider] = useState(row.provider ?? SETTINGS_DEFAULT);
  const [execution, setExecution] = useState<Execution | typeof SETTINGS_DEFAULT>(row.execution ?? SETTINGS_DEFAULT);
  const [autonomy, setAutonomy] = useState<Autonomy>(row.autonomy);
  const [requireBugbot, setRequireBugbot] = useState(row.require_bugbot);
  const [failure, setFailure] = useState<string | null>(null);
  const [savedNow, setSavedNow] = useState(false);
  const [pending, startTransition] = useTransition();
  const id = (field: string) => `repo-${field}`;

  const harnessItems = [
    { value: SETTINGS_DEFAULT, label: "Settings default" },
    ...harnesses.map((h) => ({ value: h.id, label: h.name })),
    // A default harness no machine reports enabled any more still shows, so saving keeps it.
    ...(row.provider && !harnesses.some((h) => h.id === row.provider) ? [{ value: row.provider, label: `${row.provider} (not reported by any runner)` }] : []),
  ];
  const runsOnItems = [{ value: SETTINGS_DEFAULT, label: "Settings default" }, ...EXECUTIONS.map((e) => ({ value: e, label: RUNS_ON_LABELS[e] }))];
  const autonomyItems = AUTONOMY_LEVELS.map((level) => ({ value: level, label: AUTONOMY_LABELS[level] }));

  const run = (action: () => Promise<{ ok: true } | { ok: false; message: string }>) => {
    setFailure(null);
    setSavedNow(false);
    startTransition(async () => {
      const outcome = await action();
      if (!outcome.ok) {
        setFailure(outcome.message);
        return;
      }
      setSavedNow(true);
      router.refresh();
    });
  };

  const save = () => {
    run(() =>
      saveRepository({
        repo: row.repo,
        displayName: name,
        enabled,
        provider: provider === SETTINGS_DEFAULT ? null : provider,
        execution: execution === SETTINGS_DEFAULT ? null : execution,
        autonomy,
        requireBugbot,
      }),
    );
  };

  return (
    <section aria-label={`${displayName(row)} details`} className="flex min-w-0 flex-[1_1_560px] flex-col gap-4">
      <div className={PANEL}>
        <div className="flex flex-col gap-1">
          <div className="flex items-center justify-between gap-2">
            <h2 className="truncate text-2xl leading-[30px] font-semibold">{displayName(row)}</h2>
            <StateBadge row={row} />
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted-foreground">
            <span className="font-mono">{row.repo}</span>
            {row.is_default ? (
              <Badge variant="secondary">Default</Badge>
            ) : (
              <Button
                variant="outline"
                size="sm"
                className={cn(!canEdit && "hidden")}
                disabled={pending || !row.enabled}
                onClick={() => run(() => makeDefaultRepository({ repo: row.repo }))}
              >
                Make default
              </Button>
            )}
            <span>
              {stats?.open ?? 0} open {stats?.open === 1 ? "job" : "jobs"}
            </span>
            <Button render={<a href={githubUrl(row.repo)} target="_blank" rel="noreferrer" />} variant="outline" size="sm" className="ml-auto">
              GitHub
              <ExternalLinkIcon data-icon="inline-end" />
            </Button>
          </div>
          <p className={cn("text-xs", !places.modal && places.machines.length === 0 ? "text-warning" : "text-muted-foreground")}>{placesLine(places)}</p>
        </div>
        <fieldset disabled={!canEdit} className="grid grid-cols-[repeat(auto-fit,minmax(220px,1fr))] gap-4">
          <Field>
            <FieldLabel htmlFor={id("autonomy")}>Merging</FieldLabel>
            <Select items={autonomyItems} value={autonomy} disabled={!canEdit} onValueChange={(value) => value !== null && setAutonomy(value)}>
              <SelectTrigger id={id("autonomy")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                {autonomyItems.map((item) => (
                  <SelectItem key={item.value} value={item.value}>
                    {item.label}
                  </SelectItem>
                ))}
              </SelectPopup>
            </Select>
            <FieldDescription>{AUTONOMY_HELP[autonomy]}</FieldDescription>
          </Field>
          <Field>
            <FieldLabel>Workflow</FieldLabel>
            <Button render={<Link href={workflowHref(row.repo)} />} variant="outline" className="w-full justify-between">
              {canEdit ? "Edit workflow" : "View workflow"}
              <span aria-hidden>→</span>
            </Button>
            <FieldDescription>
              sstack roles in <span className="font-mono">.sstack/roles/</span>.
            </FieldDescription>
          </Field>
          <div className="contents">
            <Field>
              <FieldLabel htmlFor={id("runs-on")}>Default runs on</FieldLabel>
              <Select
                items={runsOnItems}
                value={execution}
                disabled={!canEdit}
                onValueChange={(value) => value !== null && setExecution(value === SETTINGS_DEFAULT ? SETTINGS_DEFAULT : (value as Execution))}
              >
                <SelectTrigger id={id("runs-on")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {runsOnItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <Field>
              <FieldLabel htmlFor={id("harness")}>Default harness</FieldLabel>
              <Select items={harnessItems} value={provider} disabled={!canEdit} onValueChange={(value) => value !== null && setProvider(value)}>
                <SelectTrigger id={id("harness")} className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectPopup>
                  {harnessItems.map((item) => (
                    <SelectItem key={item.value} value={item.value}>
                      {item.label}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
            </Field>
            <p className="col-span-full text-xs text-muted-foreground">
              A ticket&apos;s Harness or Runs on label beats these, and these beat Settings. A local run needs a runner&apos;s checkout of the repo; without one
              the job runs in a cloud sandbox, or waits until it can.
            </p>
          </div>
          <Field>
            <FieldLabel htmlFor={id("name")}>Display name</FieldLabel>
            <Input id={id("name")} value={name} onChange={(e) => setName(e.target.value)} />
            <FieldDescription>Also the name of its child in the Repository label group in Linear. Run the label sync after a rename.</FieldDescription>
          </Field>
          <Field>
            <FieldLabel htmlFor={id("enabled")}>New jobs</FieldLabel>
            <Select
              items={[
                { value: "enabled", label: "Takes new jobs" },
                { value: "disabled", label: "Disabled" },
              ]}
              value={enabled ? "enabled" : "disabled"}
              onValueChange={(value) => value !== null && setEnabled(value === "enabled")}
              disabled={!canEdit || row.is_default}
            >
              <SelectTrigger id={id("enabled")} className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectPopup>
                <SelectItem value="enabled">Takes new jobs</SelectItem>
                <SelectItem value="disabled">Disabled</SelectItem>
              </SelectPopup>
            </Select>
            <FieldDescription>
              {row.is_default
                ? "The default repository always takes new jobs."
                : "A disabled repository takes no new jobs; an issue labeled with it goes to the default, and the issue is told why."}
            </FieldDescription>
          </Field>
          <Field className="col-span-full">
            <FieldLabel>
              <Switch checked={requireBugbot} onCheckedChange={setRequireBugbot} disabled={!canEdit} />
              Require Bugbot review
            </FieldLabel>
            <FieldDescription>
              A pull request waits for Bugbot&apos;s review and doesn&apos;t merge on its own with an unresolved medium or high finding. A new repo starts with
              this off; the factory turns it on the first time Bugbot reviews one of its pull requests.
            </FieldDescription>
          </Field>
          {failure && (
            <p role="alert" className="col-span-full text-sm text-destructive">
              {failure}
            </p>
          )}
        </fieldset>
        <div className={cn("flex items-center gap-3", !canEdit && "hidden")}>
          <Button onClick={save} disabled={pending}>
            {pending && <Spinner data-icon="inline-start" />}
            Save
          </Button>
          {savedNow && !pending && <span className="text-sm text-muted-foreground">Saved. New jobs use it.</span>}
        </div>
      </div>
      <div key={`${row.onboarding_state}-${row.onboarding_at?.toISOString()}`} className="flex flex-wrap items-start gap-4">
        <OnboardingSection row={row} canEdit={canEdit} />
        <OnboardingSide row={row} panelTakesSecrets={panelTakesSecrets} canEdit={canEdit} />
      </div>
    </section>
  );
}

/** Repos as cards on the left and the open one's settings and onboarding beside them, as on the canvas. Engineers see it read-only (Q40). */
export function Repositories({
  registry,
  stats,
  machines,
  selected,
  panelTakesSecrets,
  canEdit,
}: {
  registry: readonly RepoSettingsRow[];
  stats: readonly RepoStats[];
  machines: Feed<MachineRow>;
  selected: string | undefined;
  /** The panel holds a Modal token, so it takes secret values itself. */
  panelTakesSecrets: boolean;
  /** An admin; an engineer sees the page without its actions. */
  canEdit: boolean;
}) {
  useOnboardingRefresh(registry);
  const { rows, status } = useFeed(machines);
  const now = useNow(CLOCK_TICK_MS) ?? 0;
  const harnesses = useMemo(() => (reportedHarnesses(rows, now) ?? []).filter((h) => h.enabled), [rows, now]);
  const entries = useMemo(
    () => registry.map((row): Entry => ({ row, stats: stats.find((s) => s.repo === row.repo), places: placesOf(rows, now, row) })),
    [registry, stats, rows, now],
  );
  const listRef = useRef<HTMLDivElement>(null);
  // ponytail: with nothing picked the default repo is open, as the canvas always shows one; so nothing closes.
  const open = entries.find((e) => e.row.repo === selected) ?? entries.find((e) => e.row.is_default) ?? entries[0];
  const [cursor, setCursor] = useState<string | null>(open?.row.repo ?? null);
  useRowKeys(listRef, { cursor, setCursor, hrefOf: itemHref, closeHref: null });
  const enabledCount = registry.filter((r) => r.enabled).length;

  return (
    <>
      <PanelHeader title="Repositories" actions={canEdit && <AddRepository />} />
      {!open ? (
        <div className="min-h-0 flex-1 overflow-y-auto p-5">
          <Empty className="border">
            <EmptyHeader>
              <EmptyTitle>No repository is registered yet</EmptyTitle>
              <EmptyDescription>
                Add one the GitHub App can reach, or start a runner: it registers the checkouts in its config, and the first one becomes the default.
              </EmptyDescription>
            </EmptyHeader>
          </Empty>
        </div>
      ) : (
        <div className="flex min-h-0 flex-1 flex-wrap content-start items-start gap-4 overflow-y-auto p-5">
          <p className="basis-full text-muted-foreground">
            Hive onboards each repo by itself: an agent writes the setup recipe, opens a PR with it, and a warm sandbox image is built.
          </p>
          <div ref={listRef} className="max-w-[300px] min-w-0 flex-[1_1_240px]">
            <ul aria-label="Repositories" className="flex flex-col gap-1">
              {entries.map((entry) => (
                <li key={entry.row.repo}>
                  <Row entry={entry} open={entry === open} cursor={cursor === entry.row.repo} onFocus={() => setCursor(entry.row.repo)} />
                </li>
              ))}
            </ul>
          </div>
          <Detail key={open.row.repo} entry={open} harnesses={harnesses} panelTakesSecrets={panelTakesSecrets} canEdit={canEdit} />
        </div>
      )}
      <PanelFooter
        status={status}
        summary={`${registry.length} ${registry.length === 1 ? "repository" : "repositories"}, ${enabledCount} taking new jobs`}
        keys={LIST_KEYS}
      />
    </>
  );
}
