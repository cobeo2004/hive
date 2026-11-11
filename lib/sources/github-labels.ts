import { z } from "zod";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../../db/schema";
import { machines } from "../../db/schema";
import { GitHubError } from "../github/app";
import type { Harness } from "../harness";
import { sourcesOn } from "../job-sources";
import { linearSettings } from "../linear-settings";
import { reportedHarnesses } from "../machine";
import { readRegistry } from "../repositories";
import { githubDeps, WAITING, type GithubDeps } from "./github";
import { desiredLabelGroups } from "../ticket-overrides";

type Db = NodePgDatabase<typeof schema>;
type Wanted = { name: string; color: string; description: string };
const labelsSchema = z.array(z.object({ name: z.string() }));

/** The labels GitHub Issues uses (R15): the Hive label, the waiting label, and one harness: and runs-on: label per choice a ticket can make. */
export function githubLabels(label: string, harnesses: readonly Harness[] | null): Wanted[] {
  const groups = harnesses ? desiredLabelGroups(harnesses) : [];
  const children = (group: string) => groups.find((g) => g.group === group)?.children ?? [];
  return [
    { name: label, color: "fbca04", description: "Hive picks this issue up" },
    { name: WAITING, color: "d4c5f9", description: "Hive is waiting for an answer" },
    ...children("Harness").map((name) => ({ name: `harness:${name}`, color: "0e8a16", description: "The harness that leads this run" })),
    ...children("Runs on").map((name) => ({ name: `runs-on:${name}`, color: "1d76db", description: "Where this run executes" })),
  ];
}

/**
 * Creates the labels each repo lacks. A label that is there, by any case, is left as it is: nothing is
 * renamed, recoloured or deleted. A repo that cannot be reached is a problem to report, never a stop.
 */
export async function syncGithubLabels(d: Pick<GithubDeps, "request">, repos: readonly string[], wanted: readonly Wanted[]) {
  const problems: string[] = [];
  for (const repo of repos) {
    try {
      const have = new Set<string>();
      for (let page = 1; ; page++) {
        const got = labelsSchema.parse(await d.request(repo, "GET", `/repos/${repo}/labels?per_page=100&page=${page}`));
        for (const l of got) have.add(l.name.toLowerCase());
        if (got.length < 100) break;
      }
      for (const label of wanted.filter((w) => !have.has(w.name.toLowerCase()))) {
        // 422 means another writer made it in between: it is there, which is all that is wanted.
        await d.request(repo, "POST", `/repos/${repo}/labels`, label).catch((error) => {
          if (!(error instanceof GitHubError && error.status === 422)) throw error;
        });
      }
    } catch (error) {
      problems.push(`${repo}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return problems;
}

/** Every enabled registered repo, when GitHub Issues is on: after the switch turns on, after a repo is added, and now and then to catch up. */
export async function syncGithubLabelsNow(db: Db, d?: Pick<GithubDeps, "request">) {
  if (!(await sourcesOn(db)).github) return [];
  const [{ label }, rows, registry] = await Promise.all([linearSettings(db), db.select().from(machines), readRegistry(db)]);
  const repos = registry.filter((r) => r.enabled).map((r) => r.repo);
  return syncGithubLabels(d ?? (await githubDeps()), repos, githubLabels(label, reportedHarnesses(rows, Date.now())));
}
