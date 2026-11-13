import { connection } from "next/server";
import { Suspense } from "react";
import { Repositories } from "@/components/panel/repositories";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { isAdmin } from "@/lib/auth/owner";
import { load, machinesQuery } from "@/lib/live-queries";
import { modalEnvConfigured } from "@/lib/modal-secrets";
import { REPO_NAME } from "@/lib/repo-name";
import { readRegistry, readRepoStats } from "@/lib/repositories";

async function Panel({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  await connection();
  // Engineers see Repositories read-only (Q40); admins edit (R4). Every action checks the admin again.
  const canEdit = isAdmin(await currentUser());
  // load checks the member before anything is read.
  const machines = await load(machinesQuery());
  const [registry, stats, { repo }] = await Promise.all([readRegistry(db), readRepoStats(db), searchParams]);
  const selected = typeof repo === "string" && REPO_NAME.test(repo) ? repo : undefined;
  return <Repositories registry={registry} stats={stats} machines={machines} selected={selected} panelTakesSecrets={modalEnvConfigured()} canEdit={canEdit} />;
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
