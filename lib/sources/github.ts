import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../../db/schema";
import { jobs } from "../../db/schema";
import { attemptBranch, jobKey } from "../factory";
import { GITHUB_API, GitHubError, githubRequest, installationTokens, type RepoName } from "../github/app";
import { NO_OVERRIDES } from "../ticket-overrides";
import type { Job as AnyJob, JobDraft, SourceAdapter } from "./types";
import { SourceGoneError } from "./types";

type Job = AnyJob<"github">;
type Db = NodePgDatabase<typeof schema>;

/** The switch. PR B moves it into Settings; until then it is read from the env and is off by default. */
export const githubIssuesOn = (env: Readonly<Record<string, string | undefined>> = process.env) => env.FACTORY_GITHUB_ISSUES === "on";

const issues = z.array(
  z.object({
    number: z.number().int(),
    title: z.string(),
    html_url: z.string(),
    body: z.string().nullable(),
    labels: z.array(z.object({ name: z.string() })),
    pull_request: z.unknown().optional(),
  }),
);

export type GithubDeps = {
  /** One GitHub call as the repo's installation; a 404 throws GitHubError like any other refusal. */
  request: (repo: string, method: string, path: string, body?: unknown) => Promise<unknown>;
  db: Db;
  /** The Hive label, the one Settings → Linear holds for both sources (R16). */
  label: () => Promise<string>;
};

async function runtimeDeps(): Promise<GithubDeps> {
  const [{ db }, { linearSettings }] = await Promise.all([import("../../db/client"), import("../linear-settings")]);
  return {
    db,
    label: async () => (await linearSettings(db)).label,
    request: async (repo, method, path, body) => (await githubRequest(GITHUB_API, await installationTokens.get(repo as RepoName), method, path, { body })).json,
  };
}

const soft = (p: Promise<unknown>) =>
  p.catch((error) => {
    if (error instanceof GitHubError && error.status === 404) return undefined;
    throw error;
  });

/** A key too long for the format reaches the claim as it is, and the claim reports it. */
function keyOf(repo: string, number: number) {
  try {
    return jobKey("GH", number, repo);
  } catch {
    return `GH-${repo}-${number}`;
  }
}

/** Every open issue carrying the label, a page at a time. */
async function openIssues(d: GithubDeps, repo: string, label: string) {
  const all: z.infer<typeof issues> = [];
  for (let page = 1; ; page++) {
    const got = issues.parse(await d.request(repo, "GET", `/repos/${repo}/issues?state=open&labels=${encodeURIComponent(label)}&per_page=100&page=${page}`));
    all.push(...got);
    if (got.length < 100) return all;
  }
}

export function createGithubAdapter(load: () => GithubDeps | Promise<GithubDeps>, on: () => boolean = githubIssuesOn): SourceAdapter<"github"> {
  let loaded: GithubDeps | undefined;
  const deps = async () => (loaded ??= await load());
  const issuePath = (job: Pick<Job, "writeback">) => `/repos/${job.writeback.repo}/issues/${job.writeback.number}`;
  /** Tells a labelled issue in a repo Hive is not enabled for why nothing happens, once. */
  async function declineOnce(d: GithubDeps, repo: string, number: number, label: string) {
    const marker = "<!-- hive-declined -->";
    const path = `/repos/${repo}/issues/${number}/comments`;
    // ponytail: looks at the first 100 comments; a longer thread may get the note twice.
    const seen = z.array(z.object({ body: z.string() })).parse(await d.request(repo, "GET", `${path}?per_page=100`));
    if (seen.some((c) => c.body.includes(marker))) return;
    await d.request(repo, "POST", path, {
      body: `Hive is not enabled for ${repo}, so it did not pick this issue up. Enable the repository in Hive, then add the \`${label}\` label again.\n\n${marker}`,
    });
  }

  /** R5: the attempt's one status comment, edited in place; made once if the attempt has none yet. */
  async function setStatus(d: GithubDeps, job: Job, text: string) {
    const { repo } = job.writeback;
    const id = job.source_state.statusAttempt === job.attempt ? job.source_state.statusCommentId : null;
    if (id && (await soft(d.request(repo, "PATCH", `/repos/${repo}/issues/comments/${id}`, { body: text })))) return;
    const made = z.object({ id: z.number().int() }).parse(await d.request(repo, "POST", `${issuePath(job)}/comments`, { body: text }));
    // The id is Hive's own from here on, so it can never read as a reply.
    const patch = JSON.stringify({
      statusCommentId: made.id,
      statusAttempt: job.attempt,
      factoryCommentIds: [...job.source_state.factoryCommentIds, String(made.id)],
    });
    await d.db
      .update(jobs)
      .set({ source_state: sql`${jobs.source_state} || ${patch}::jsonb` })
      .where(eq(jobs.id, job.id));
  }

  return {
    source: "github",
    async ready() {
      if (!on()) return [];
      const d = await deps();
      const label = await d.label();
      const { readRegistry } = await import("../repositories");
      const drafts: JobDraft<"github">[] = [];
      const errors: unknown[] = [];
      for (const { repo, enabled } of await readRegistry(d.db)) {
        try {
          for (const issue of (await openIssues(d, repo, label)).filter((i) => !i.pull_request)) {
            if (!enabled) {
              await declineOnce(d, repo, issue.number, label);
              continue;
            }
            drafts.push({
              externalId: `${repo}#${issue.number}`,
              key: keyOf(repo, issue.number),
              title: issue.title,
              url: issue.html_url,
              description: issue.body,
              writeback: { kind: "github", repo, number: issue.number },
              sourceState: { labels: issue.labels.map((l) => l.name) },
              // R2: the issue's own repo; the claim refuses it rather than route it anywhere else.
              repo,
            });
          }
        } catch (error) {
          // One repo's outage (a revoked installation) must not stop intake from the others.
          console.error("github: could not read issues of", repo, error);
          errors.push(error);
        }
      }
      if (errors.length && !drafts.length) throw errors[0];
      return drafts;
    },
    async announceClaim(job) {
      if (job.source_state.statusAttempt === job.attempt) return;
      const again = job.attempt > 1 ? ` again (attempt ${job.attempt}, branch ${attemptBranch(job.key, job.attempt)})` : "";
      await setStatus(await deps(), job, `Hive picked this up${again}.`);
    },
    async writeBack(job, { stage }) {
      if (stage === "queued") return false;
      const d = await deps();
      const { repo } = job.writeback;
      const label = await d.label();
      try {
        await setStatus(
          d,
          job,
          [
            `Hive: **${stage}**`,
            job.stage_summary,
            job.pr_url && `Pull request: ${job.pr_url}`,
            stage === "waiting" && "Waiting for an answer on this issue.",
            stage === "failed" && `Add the \`${label}\` label again to retry.`,
          ]
            .filter(Boolean)
            .join("\n\n"),
        );
        // Back to unstarted without the label, so the poll does not claim it again in a loop; the label retries it.
        if (stage === "failed") await soft(d.request(repo, "DELETE", `${issuePath(job)}/labels/${encodeURIComponent(label)}`));
        return true;
      } catch (error) {
        if (error instanceof GitHubError && error.status === 404) throw new SourceGoneError(error.message);
        throw error;
      }
    },
    // Questions and answers arrive in the next PR; until then a waiting job waits.
    replies: async () => ({ kind: "wait" }),
    acknowledgeReplies: async () => {},
    note: async () => {},
    // Stops arrive in a later PR; until then a running job is stopped from the panel.
    stopWanted: async () => [],
    confirmStop: async () => ({ stop: false }),
    labels: async () => [],
    async reopen() {},
    async requeue(job) {
      const d = await deps();
      await d.request(job.writeback.repo, "POST", `${issuePath(job)}/labels`, { labels: [await d.label()] });
    },
    overrides: () => NO_OVERRIDES,
    launchNote: (job) =>
      `When you open the pull request, put "Fixes #${job.writeback.number}" in its body so merging closes the issue. Never close the issue yourself.`,
    describe: (job) => `GitHub issue ${job.key}`,
  };
}

export const github = createGithubAdapter(runtimeDeps);
