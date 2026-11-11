import "./test-guard";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { linearSettings, repoSettings } = await import("../db/schema");
const { writeSourceChoice } = await import("../lib/job-sources");
const { GitHubError } = await import("../lib/github/app");
const { githubLabels, syncGithubLabels, syncGithubLabelsNow } = await import("../lib/sources/github-labels");

// R15: the labels GitHub Issues needs, created where they are missing and never renamed, recoloured or deleted.
const harnesses = [
  { name: "codex", enabled: true },
  { name: "claude", enabled: true },
  { name: "off", enabled: false },
] as never;
const wanted = githubLabels("hive", harnesses);
const names = wanted.map((w) => w.name);
assert.deepEqual(names.slice(0, 2), ["hive", "hive:waiting"], "the pickup label and the waiting label come first");
assert.ok(names.includes("harness:codex") && names.includes("harness:claude"), "one harness: label per enabled harness");
assert.ok(!names.includes("harness:off"), "a disabled harness gets none");
assert.deepEqual(names.filter((n) => n.startsWith("runs-on:")).sort(), ["runs-on:Cloud", "runs-on:Local"], "both places a run can execute");
assert.equal(githubLabels("triage", null)[0]!.name, "triage", "the label is the one set in Settings");
assert.ok(!githubLabels("hive", null).some((w) => w.name.startsWith("harness:")), "before any machine reports, no harness: labels");

const GOOD = "owner/good";
const BAD = "owner/bad";
const OFF = "owner/off";
const have = new Map<string, string[]>();
const calls: string[] = [];
let race = false;
const request = async (repo: string, method: string, path: string, input?: unknown) => {
  calls.push(`${method} ${repo} ${path}`);
  if (repo === BAD) throw new Error("installation revoked");
  if (method === "GET") {
    const page = Number(/[?&]page=(\d+)/.exec(path)![1]);
    return (have.get(repo) ?? []).slice((page - 1) * 100, page * 100).map((name) => ({ name }));
  }
  assert.equal(method, "POST", "only GET and POST: nothing is renamed or deleted");
  if (race) throw new GitHubError("already exists", 422);
  have.set(repo, [...(have.get(repo) ?? []), (input as { name: string }).name]);
  return {};
};
const created = () => calls.filter((c) => c.startsWith("POST")).length;

have.set(GOOD, ["Hive", "bug", "RUNS-ON:local"]);
assert.deepEqual(await syncGithubLabels({ request }, [GOOD], wanted), []);
assert.ok(!have.get(GOOD)!.includes("hive"), "a label there under another case is left as it is");
assert.equal(created(), wanted.length - 2, "only the missing ones are created, case aside");
assert.ok(have.get(GOOD)!.includes("bug"), "labels it does not know are untouched");

calls.length = 0;
await syncGithubLabels({ request }, [GOOD], wanted);
assert.equal(created(), 0, "a second run creates nothing");

// More than a page of labels: the one wanted on page two is seen, not created again.
have.set(OFF, [...Array.from({ length: 100 }, (_, i) => `x${i}`), "hive:waiting"]);
calls.length = 0;
await syncGithubLabels({ request }, [OFF], [wanted[1]!]);
assert.equal(created(), 0, "labels past the first page count");

race = true;
have.set(GOOD, []);
assert.deepEqual(await syncGithubLabels({ request }, [GOOD], wanted), [], "a label made in between (422) is not a problem");
race = false;

calls.length = 0;
have.delete(GOOD);
const problems = await syncGithubLabels({ request }, [BAD, GOOD], wanted);
assert.equal(problems.length, 1, "one unreachable repo is one problem");
assert.match(problems[0]!, /owner\/bad: installation revoked/);
assert.equal(have.get(GOOD)!.length, wanted.length, "and does not stop the next repo");

// Against the registry: nothing happens while GitHub Issues is off; on, only enabled repos are served.
try {
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [GOOD, OFF]));
  const meta = { updated_at: new Date(), updated_by: "regress" };
  await db.insert(repoSettings).values([
    { repo: GOOD, enabled: true, ...meta },
    { repo: OFF, enabled: false, ...meta },
  ]);
  await db.delete(linearSettings);
  have.clear();
  calls.length = 0;
  assert.deepEqual(await syncGithubLabelsNow(db, { request }), []);
  assert.equal(calls.length, 0, "GitHub Issues off: no repo is called");
  await writeSourceChoice(db, "github", "regress");
  await syncGithubLabelsNow(db, { request });
  assert.ok(calls.length > 0 && calls.every((c) => c.includes(GOOD)), "on: the enabled repo is served and the disabled one is not");
  assert.ok(have.get(GOOD)!.includes("hive") && have.get(GOOD)!.includes("hive:waiting"));
} finally {
  await db.delete(repoSettings).where(inArray(repoSettings.repo, [GOOD, OFF]));
  await db.delete(linearSettings);
}
console.log("all github-labels regressions passed");
process.exit(0);
