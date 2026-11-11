import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, like } from "drizzle-orm";

const { db } = await import("../db/client");
const { jobs, repoSettings } = await import("../db/schema");
const { allSources, parseJobs, SOURCES } = await import("../lib/sources");
const { createGithubAdapter } = await import("../lib/sources/github");
const { isJobKey, parseBranch, attemptBranch } = await import("../lib/factory");
const { readRegistry } = await import("../lib/repositories");
const ops = await import("../runner/ops");
import type { Job } from "../lib/sources/types";

// GitHub Issues as a job source, against an in-memory GitHub: intake, the repo rule and the status
// comment. The adapter's own calls are all it knows of GitHub.

const ON = "test-owner/gh-on";
const OFF = "test-owner/gh-off";
const DEFAULT = "test-owner/gh-default";
const GONE = "test-owner/gh-gone";
type Issue = {
  number: number;
  title: string;
  html_url: string;
  body: null;
  state: string;
  labels: { name: string }[];
  pull_request?: object;
  comments: { id: number; body: string }[];
};
const gh = new Map<string, Issue>();
const calls: string[] = [];
let ids = 100;
let down = "";
const put = (repo: string, number: number, over: Partial<Issue> = {}) =>
  gh.set(`${repo}#${number}`, { number, title: "t", html_url: `u/${number}`, body: null, state: "open", labels: [{ name: "hive" }], comments: [], ...over });
const request = async (repo: string, method: string, path: string, input?: unknown): Promise<unknown> => {
  calls.push(`${method} ${repo} ${path}`);
  const body = input as { body?: string; labels?: string[] } | undefined;
  if (repo === down) throw new Error("installation revoked");
  if (![ON, OFF, DEFAULT].includes(repo)) throw new Error(`the adapter reached ${repo}, which is not registered`);
  const list = path.match(/\/issues\?.*labels=([^&]+)/);
  if (list)
    return [...gh]
      .filter(([k, i]) => k.startsWith(`${repo}#`) && i.state === "open" && i.labels.some((l) => l.name === decodeURIComponent(list[1]!)))
      .map(([, i]) => i)
      .slice((Number(path.match(/&page=(\d+)/)![1]) - 1) * 100)
      .slice(0, 100);
  const edit = path.match(/\/issues\/comments\/(\d+)$/);
  if (edit) {
    const hit = [...gh.values()].flatMap((i) => i.comments).find((c) => c.id === Number(edit[1]));
    hit!.body = body!.body!;
    return hit;
  }
  const [, number, rest, name] = path.match(/\/issues\/(\d+)(?:\/(comments|labels)(?:\/([^?]+))?)?/)!;
  const issue = gh.get(`${repo}#${number}`)!;
  if (rest === "comments" && method === "GET") return issue.comments;
  if (rest === "comments") return issue.comments[issue.comments.push({ id: ++ids, body: body!.body! }) - 1];
  if (rest === "labels" && method === "POST") issue.labels.push(...body!.labels!.map((n) => ({ name: n })));
  if (rest === "labels" && method === "DELETE") issue.labels = issue.labels.filter((l) => l.name !== decodeURIComponent(name!));
  return issue;
};
let on = true;
const adapter = createGithubAdapter(
  async () => ({ db, request, label: async () => "hive" }),
  () => on,
);
const comments = (repo: string, number: number) => gh.get(`${repo}#${number}`)!.comments;
const names = (n: number) => gh.get(`${ON}#${n}`)!.labels.map((l) => l.name);

try {
  await db.delete(jobs).where(like(jobs.id, "github:%"));
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [ON, OFF, DEFAULT, GONE]));
  const meta = { updated_at: new Date(), updated_by: "regress" };
  await db.insert(repoSettings).values([
    { repo: ON, enabled: true, ...meta },
    { repo: OFF, enabled: false, ...meta },
    { repo: DEFAULT, enabled: true, is_default: true, ...meta },
  ]);
  // R1: both sources are registered, and with the switch off GitHub reads nothing.
  assert.ok(allSources().some((s) => s.source === "github") && SOURCES.linear, "github is registered beside linear");
  on = false;
  assert.deepEqual(await adapter.ready(), [], "off: nothing is offered");
  assert.deepEqual(calls, [], "off: GitHub is never called");
  on = true;
  // R2, R3, R10: the open labelled issues of registered repos, each with its key and its own repo.
  put(ON, 7);
  put(ON, 8);
  put(ON, 9, { labels: [{ name: "bug" }] });
  put(ON, 10, { pull_request: {} });
  put(ON, 11, { state: "closed" });
  put(OFF, 3);
  const drafts = await adapter.ready();
  assert.deepEqual(drafts.map((d) => d.externalId).sort(), [`${ON}#7`, `${ON}#8`], "only open labelled issues, not PRs, in enabled repos");
  const seven = drafts.find((d) => d.externalId === `${ON}#7`)!;
  assert.deepEqual([seven.key, seven.repo, seven.writeback, seven.url], ["GH-test-owner-gh-on-7", ON, { kind: "github", repo: ON, number: 7 }, "u/7"]);
  assert.ok(isJobKey(seven.key) && parseBranch(attemptBranch(seven.key, 1))?.key === seven.key, "the key and its branch parse back");
  assert.equal(comments(OFF, 3).length, 1, "a labelled issue in a disabled repo is not offered, and says why");
  assert.match(comments(OFF, 3)[0]!.body, /not enabled for test-owner\/gh-off/);
  await adapter.ready();
  assert.equal(comments(OFF, 3).length, 1, "and says it once");
  // Claim: the job runs in the issue's own repo, never the default one.
  const registry = () => readRegistry(db);
  const landed = () => db.select({ key: jobs.key, repo: jobs.repo }).from(jobs).where(like(jobs.id, "github:%"));
  const claimed = await ops.claim({ sources: [adapter], repos: async () => [DEFAULT], registry });
  assert.deepEqual(claimed.claimed.sort(), ["GH-test-owner-gh-on-7", "GH-test-owner-gh-on-8"]);
  const reposOf = async () => (await landed()).map((j) => j.repo);
  assert.deepEqual(await reposOf(), [ON, ON]);
  // A repo disabled or removed between ready() and the claim is refused: no job, no default repo.
  const draft = (repo: string, number: number) => ({
    ...seven,
    externalId: `${repo}#${number}`,
    key: `GH-${repo.replace("test-owner/", "test-owner-")}-${number}`,
    repo,
    writeback: { kind: "github" as const, repo, number },
  });
  const stale = { ...adapter, ready: async () => [draft(GONE, 5), draft(OFF, 3), draft(ON, 12)] };
  await assert.rejects(
    () => ops.claim({ sources: [stale], repos: async () => [DEFAULT], registry }),
    (e: Error) => /gh-gone-5.*not an enabled repository/.test(e.message) && /gh-off-3/.test(e.message) && /claimed GH-test-owner-gh-on-12/.test(e.message),
  );
  assert.deepEqual(await reposOf(), [ON, ON, ON], "the refused issues have no job, the others still go, nothing falls back to the default");
  // R5, R6: one status comment per attempt, edited in place; Hive never closes the issue.
  const job = async (n: number) => {
    const rows = await db
      .select()
      .from(jobs)
      .where(eq(jobs.id, `github:${ON}#${n}`));
    return parseJobs(rows)[0] as Job<"github">;
  };
  const patch = (n: number, set: Partial<typeof jobs.$inferInsert>) =>
    db
      .update(jobs)
      .set(set)
      .where(eq(jobs.id, `github:${ON}#${n}`));
  await adapter.announceClaim(await job(7));
  await adapter.announceClaim(await job(7));
  assert.equal(comments(ON, 7).length, 1, "announcing twice makes one comment");
  await patch(7, { pr_url: `https://github.com/${ON}/pull/9`, stage_summary: "built it" });
  assert.equal(await adapter.writeBack(await job(7), { stage: "pr", eventId: "e1" }), true);
  assert.equal(comments(ON, 7).length, 1, "a stage edits the status comment in place");
  assert.match(comments(ON, 7)[0]!.body, /\*\*pr\*\*[\s\S]*built it[\s\S]*pull\/9/);
  assert.equal((await job(7)).source_state.factoryCommentIds.length, 1, "its id is Hive's own");
  assert.ok(adapter.launchNote!(await job(7)).includes('"Fixes #7"'), "the thread is told to write Fixes #n");
  assert.ok(!calls.some((c) => /^(PATCH|PUT|DELETE) \S+ \/repos\/\S+\/issues\/\d+$/.test(c)), "Hive never edits or closes the issue itself");
  await adapter.writeBack(await job(7), { stage: "failed", eventId: "e2" });
  assert.deepEqual(names(7), [], "a failed job loses the Hive label, so the poll does not claim it again");
  await adapter.requeue(await job(7));
  assert.deepEqual(names(7), ["hive"], "requeue puts it back");
  await patch(7, { attempt: 2 });
  await adapter.announceClaim(await job(7));
  assert.equal(comments(ON, 7).length, 2, "a new attempt gets its own status comment");
  // Past the first page of issues is still read, and one repo's outage hides nothing from the rest.
  for (let n = 300; n <= 400; n++) put(DEFAULT, n);
  down = OFF;
  assert.equal((await adapter.ready()).filter((d) => d.repo === DEFAULT).length, 101);
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  await db.delete(jobs).where(like(jobs.id, "github:%"));
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [ON, OFF, DEFAULT, GONE]));
  process.exit(process.exitCode ?? 0);
}
