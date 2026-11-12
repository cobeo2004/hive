import { connection } from "next/server";
import { Suspense } from "react";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { PanelHeader } from "@/components/panel/panel-header";
import { Repositories } from "@/components/panel/repositories";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/owner";
import { load, machinesQuery } from "@/lib/live-queries";
import { modalEnvConfigured } from "@/lib/modal-secrets";
import { REPO_NAME } from "@/lib/repo-name";
import { readRegistry, readRepoStats } from "@/lib/repositories";
import { readSettings, resolveExecution } from "@/lib/settings";

async function Panel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  // Repositories is admin-only (R4), so an engineer gets the 403 card instead of a page whose every action refuses them.
  if (!isAdmin(await currentUser()))
    return (
      <>
        <PanelHeader title="Repositories" />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6">
          <ForbiddenCard reason="admin" />
        </div>
      </>
    );
  // load checks the member before anything is read.
  const machines = await load(machinesQuery());
  const [registry, stats, settings, { repo }] = await Promise.all([readRegistry(db), readRepoStats(db), readSettings(db), searchParams]);
  const selected = typeof repo === "string" && REPO_NAME.test(repo) ? repo : undefined;
  return (
    <Repositories
      registry={registry}
      stats={stats}
      machines={machines}
      selected={selected}
      panelTakesSecrets={modalEnvConfigured()}
      defaultExecution={resolveExecution(settings)}
    />
  );
}

export default function RepositoriesPage(props: PageProps<"/repositories">) {
  return (
    <Suspense
      fallback={
        <PageSkeleton title="Repositories">
          <RowsSkeleton />
        </PageSkeleton>
      }
    >
      <Panel searchParams={props.searchParams} />
    </Suspense>
  );
}
