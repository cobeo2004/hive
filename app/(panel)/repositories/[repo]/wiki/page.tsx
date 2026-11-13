import { eq } from "drizzle-orm";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { Suspense } from "react";
import { PanelHeader } from "@/components/panel/panel-header";
import { PageSkeleton, RowsSkeleton } from "@/components/panel/skeletons";
import { WikiGraphView } from "@/components/panel/wiki-graph";
import { db } from "@/db/client";
import { repoSstackConfig } from "@/db/schema";
import { assertMember } from "@/lib/auth/server";
import { REPO_NAME } from "@/lib/repo-name";
import { wikiGraph } from "@/lib/wiki-graph";

async function Panel({ params }: { params: Promise<{ repo: string }> }) {
  await connection();
  await assertMember();
  // The segment is `owner%2Fname`; a malformed `%` escape stays "" and REPO_NAME below is notFound().
  let repo = "";
  try {
    repo = decodeURIComponent((await params).repo);
  } catch {
    // keep "" so the REPO_NAME check below returns notFound()
  }
  if (!REPO_NAME.test(repo)) notFound();
  const [row] = await db.select({ files: repoSstackConfig.files }).from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo)).limit(1);
  return (
    <>
      <PanelHeader title={`Wiki · ${repo}`} />
      <WikiGraphView graph={wikiGraph(row?.files ?? {})} />
    </>
  );
}

export default function WikiPage(props: PageProps<"/repositories/[repo]/wiki">) {
  return (
    <Suspense
      fallback={
        <PageSkeleton title="Wiki">
          <RowsSkeleton />
        </PageSkeleton>
      }
    >
      <Panel params={props.params} />
    </Suspense>
  );
}
