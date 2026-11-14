import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { ForbiddenCard } from "@/components/auth/forbidden-card";
import { PanelHeader } from "@/components/panel/panel-header";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { WorkflowCanvas } from "@/components/panel/workflow-canvas";
import { db } from "@/db/client";
import { repoSettings, repoSstackConfig } from "@/db/schema";
import { isAdmin } from "@/lib/auth/owner";
import { currentUser } from "@/lib/auth/server";
import { REPO_NAME } from "@/lib/repo-name";

async function Panel({ params }: { params: Promise<{ repo: string }> }) {
  await connection();
  const user = await currentUser();
  if (!user) return <ForbiddenCard reason="admin" />;
  // The segment is `owner%2Fname`; a malformed `%` escape stays "" and REPO_NAME below is notFound().
  let repo = "";
  try {
    repo = decodeURIComponent((await params).repo);
  } catch {
    // keep "" so the REPO_NAME check below returns notFound()
  }
  if (!REPO_NAME.test(repo)) notFound();
  // Only a registered repo has a workflow page, whatever snapshot rows remain from an earlier registration.
  const [row] = await db
    .select({ files: repoSstackConfig.files })
    .from(repoSettings)
    .leftJoin(repoSstackConfig, eq(repoSstackConfig.repo, repoSettings.repo))
    .where(eq(repoSettings.repo, repo))
    .limit(1);
  if (!row) notFound();
  if (!row.files)
    return (
      <>
        <PanelHeader title={`Workflow · ${repo}`} />
        <div className="flex min-h-0 flex-1 items-center justify-center p-6 text-muted-foreground">
          No sstack snapshot yet: the runner records one after onboarding.
        </div>
      </>
    );
  return <WorkflowCanvas repo={repo} files={row.files} canEdit={isAdmin(user)} />;
}

export default function WorkflowPage(props: PageProps<"/repositories/[repo]/workflow">) {
  return (
    <Suspense
      fallback={
        <PageSkeleton title="Workflow">
          <RowsSkeleton />
        </PageSkeleton>
      }
    >
      <Panel params={props.params} />
    </Suspense>
  );
}
