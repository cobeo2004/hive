import "./test-guard";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

declare const Bun: { TOML: { parse(text: string): unknown } }; // no bun-types in tsc
const { patch } = await import("../lib/toml-patch");
const { parseBranch } = await import("../lib/factory");
const { mayCreate, runWorkflowPr, runWorkflowSmoke, workflowDeps } = await import("../runner/workflow-pr");
const { readToml, steps, chain, move, diffLines, meta, tomlError } = await import("../lib/workflow-chain");

const REPO = "acme/sstack";
const ROLE = ".sstack/roles/implement.toml";
const STEP = ".sstack/steps/review/step.toml";
const CONFIG = ".sstack/config.toml";
const implement = '# implement role\n\nharness = "claude"  # who implements\nmodel = "opus"\n';
const step = "id = 'review'\nafter = 'implement'\n";
const config = "workflow = 'default'\n";
const harnessModel = 'harness = "claude"\nmodel = "opus"\n';
const lines = (text: string) => text.split(/(?<=\n)/);

const root = mkdtempSync(join(tmpdir(), "hive-workflow-"));
const checkout = join(root, "sstack");
const bare = join(root, "sstack.git");
const GIT = ["-c", "core.autocrlf=false", "-c", "user.name=regression", "-c", "user.email=regression@example.com", "-c", "commit.gpgsign=false"];
const git = (cwd: string, ...args: string[]) => execFileSync("git", [...GIT, ...args], { cwd, encoding: "utf8" }).trim();
const heads = () => git(root, "ls-remote", "--heads", bare, "hive/*");

// A checkout with a real bare origin: the runner fetches main from it and pushes its branch to it.
for (const dir of [checkout, bare]) mkdirSync(dir);
git(bare, "init", "-q", "--bare", "-b", "main");
git(checkout, "init", "-q", "-b", "main");
git(checkout, "remote", "add", "origin", bare);
for (const [path, text] of Object.entries({ [ROLE]: implement, [STEP]: step, [CONFIG]: config })) {
  mkdirSync(dirname(join(checkout, path)), { recursive: true });
  writeFileSync(join(checkout, path), text);
}
git(checkout, "add", "-A");
git(checkout, "commit", "-q", "-m", "main");
git(checkout, "push", "-q", "origin", "HEAD:refs/heads/main");

const pulls: { repo: string; title: string; head: string; base: string; body: string }[] = [];
const doctorCalls: { cwd: string; role: string | null }[] = [];
let doctor = { code: 0, output: "ok" };
let checkouts = 0;
const realDoctor = workflowDeps.doctor;
mkdirSync(join(root, "work"));
Object.assign(workflowDeps, {
  checkout: async (repo: string) => (checkouts++, repo === REPO ? checkout : null),
  remote: () => bare,
  token: async () => "ghs_fake",
  dir: join(root, "work"),
  doctor: async (cwd: string) => (doctorCalls.push({ cwd, role: existsSync(join(cwd, ROLE)) ? readFileSync(join(cwd, ROLE), "utf8") : null }), doctor),
  github: {
    createPull: async (repo: string, pull: { title: string; head: string; base: string; body: string }) => (
      pulls.push({ repo, ...pull }), { url: `https://github.com/${repo}/pull/${pulls.length}` }
    ),
  },
  now: () => new Date("2026-11-11T01:20:00.123Z"),
});
const proposed = { [ROLE]: patch(implement, "", "harness", "codex"), [STEP]: patch(step, "", "after", "plan") };

try {
  // 1. a role change is one line, with its comment and spacing kept
  const role = patch(implement, "", "harness", "codex");
  assert.equal(role, '# implement role\n\nharness = "codex"  # who implements\nmodel = "opus"\n');

  // 3. a missing key goes to the end of its section, ahead of the blank line before the next header
  assert.equal(patch("[a]\nx = 1\n\n[b]\ny = 2\n", "a", "z", true), "[a]\nx = 1\nz = true\n\n[b]\ny = 2\n");
  assert.equal(patch("# c\n[a]\nx = 1\n", "", "k", "v"), '# c\nk = "v"\n[a]\nx = 1\n', "top level goes above the first header");
  assert.equal(patch("\n[a]\n", "", "k", 1), "k = 1\n\n[a]\n", "an all-blank top level takes it first");
  assert.equal(patch("[a]\r\nx = 1\r\n", "a", "z", 2), "[a]\r\nx = 1\r\nz = 2\r\n", "CRLF stays CRLF");
  assert.equal(patch("[a]\nx = 1", "a", "z", 2), "[a]\nx = 1\nz = 2\n", "a last line without an EOL gets one");
  assert.equal(patch("[a]\n[b]\n", "a", "z", 2), "[a]\nz = 2\n[b]\n", "an empty section takes it after its header");

  assert.equal(patch("x = 1", "new", "k", "v"), 'x = 1\n\n[new]\nk = "v"\n');
  assert.equal(patch("[a]\nk = 1\n", "b", "k", "v"), '[a]\nk = 1\n\n[b]\nk = "v"\n');

  // 5. every other line stays byte-identical
  const messy = lines(
    '# top comment\nname   =   "a # not a comment"   # real comment\n[[array]]\nx = 1\n[meta]\n  keep =  [1,   2]   # arr\n  harness="old"\ntail = \'x\'\n',
  );
  const patched = lines(patch(messy.join(""), "meta", "harness", "new"));
  assert.equal(patched.length, messy.length);
  patched.forEach((line, i) => assert.equal(line, i === 6 ? '  harness="new"\n' : messy[i]));
  assert.equal(patch(messy.join(""), "", "name", "b").split("\n")[1], 'name   =   "b"   # real comment');
  const multi = 'note = """\nharness = "x"\n[a]\n"""\nharness = "claude"\n';
  assert.equal(patch(multi, "", "harness", "codex"), multi.replace("claude", "codex"), "lines inside a multi-line string are not keys or headers");
  assert.equal(patch("[a]", "a", "k", 1), "[a]\nk = 1\n", "a header with no EOL gets one before the key");
  assert.equal(patch('x = ["#"]  # c\n', "", "x", 2), "x = 2  # c\n", "a # inside a quoted value is not a comment");
  const swap = (text: string, section = "a") => patch(text, section, "k", 2);
  const keeps = (text: string, section = "a", why = "") => assert.equal(swap(text, section), text.replace("k = 1", "k = 2"), why);
  keeps('# """\n[a]\nk = 1\n', "a", "triple quotes in a comment open nothing");
  keeps('s = "a \\"\\"\\" b"\n[a]\nk = 1\n', "a", "escaped quotes in a string");
  keeps('s = \'"""\'\n[a]\nk = 1\n', "a", "triple quotes in a literal string");
  keeps("a = [\n [1]\n]\n[b]\nk = 1\n", "b", "array rows are not headers");
  assert.equal(swap('["a.b"]\nx = 1\n', "a.b"), '["a.b"]\nx = 1\n\n[a.b]\nk = 2\n', "a quoted dotted name is a different table");
  // the parser is the arbiter: what the line patch cannot do exactly throws (rows of `text~section~key`)
  const refuse =
    'a = """\nx\n"""\n~~a|a = [\n1,\n]\n~~a|[a]\n"k" = 1\n~a~k|[a]\n\'k\' = 1\n~a~k|[a]\nk.x = 1\n~a~k|"\\u006b" = 1\n~~k|a = { x = 1 }\n~a~k|a = { b = { k = 1 } }\n~a.b~k|[[a]]\nk = 1\n~a~k|["a . b"]\nk = 1\n~"a.b"~k|["a . b"]\nk = 1\n~"a . b"~k|k = 1\n~~a.b|k = [1\n~~k|a = 1\n~a~k|[[a]]\n[a.b]\n~a.b~k';
  for (const row of refuse.split("|")) assert.throws(() => patch(...(row.split("~") as [string, string, string]), 2), /^Error: toml-patch: /, row);
  for (const v of ["\ud800", Number.NaN]) assert.throws(() => patch("k = 1\n", "", "k", v), /^Error: toml-patch: /);
  // differential: every call throws, or returns text that parses to the original with that one value set
  const raw =
    '|\n|k = 1|k = 1\r\n|# c\n[a]\nk = 1 # c\n|[a]\n[a.b]\nk = 1\n|[a.b]\nk = 1\n[c]\n|[a]\nx = { k = 1 }\n|[[a]]\nk = 1\n[b]\n|a.b.k = 1\n|[a]\nb.k = 1\n|x = [\n 1,\n]\nk = 3\n|x = """\nk = 1\n[a]\n"""\n|\'k\' = 1\n|"k" = 1\n|[ a . b ]\nk=1|[a]\n[b]\nk = \'v\' # c\n|k = "a # b"\n[a]\n|[a]\r\nk = 1\r\n[b]\r\n|d = 1979-05-27T07:32:00Z\n[a]\n|[a]\nk = 1\n[a.b]\nk = 2\n|a = { b = 1 }\n|["a"]\nk = 1\n|x = [[1], [2]]\n[a]\n|[a] # c\n|k = 0x10\n[a]\nk = 1.5\n|[a]\nk = [1,\n2]\n|[a.b.c]\nz = 1\n|[a]\nz = \'\'\'\nk = 1\n\'\'\'\n|k=1\n[k]\n';
  const json = (text: string) => JSON.parse(JSON.stringify(Bun.TOML.parse(text)));
  let done = 0;
  for (const text of raw.split("|"))
    for (const target of "/k a/k a.b/k b/z a.b.c/k /a".split(" "))
      for (const v of ["v", 7, true]) {
        const [section, k] = target.split("/") as [string, string];
        try {
          const out = json(patch(text, section, k, v));
          const want = json(text);
          let t = want;
          for (const part of section.split(".")) if (part) t = t[part] ??= {};
          t[k] = v;
          assert.deepEqual(out, want, JSON.stringify([text, section, k, v]));
          done++;
        } catch (error) {
          if (!/^toml-patch: /.test((error as Error).message)) throw error; // refusing is fine, a wrong result is not
        }
      }
  assert.ok(done > 100, `differential: only ${done} patched`);

  // 6. a failing doctor opens no PR and pushes nothing, and its output reaches the error
  doctor = { code: 1, output: "roles/implement.toml: unknown harness" };
  await assert.rejects(
    runWorkflowPr({ repo: REPO, files: proposed }),
    (error: Error) => error.message.includes(doctor.output) && error.message.includes("exit 1"),
  );
  assert.equal(pulls.length, 0);
  assert.equal(heads(), "", "nothing pushed");
  assert.equal(git(checkout, "worktree", "list").split("\n").length, 1, "the worktree is gone");

  // 7. a passing doctor opens a PR from a unique branch that parses as no job, holding only the changed files
  doctor = { code: 0, output: "ok" };
  const { url, branch } = await runWorkflowPr({ repo: REPO, files: proposed });
  assert.match(branch, /^hive\/workflow-acme-sstack-20261111T012000Z$/);
  assert.equal(parseBranch(branch), undefined, "a workflow branch is no job's");
  assert.equal(pulls.length, 1);
  assert.equal(url, "https://github.com/acme/sstack/pull/1");
  assert.deepEqual([pulls[0]!.repo, pulls[0]!.head, pulls[0]!.base], [REPO, branch, "main"]);
  assert.match(pulls[0]!.body, /sstack-doctor passed/);
  assert.equal(git(bare, "diff", "--name-only", "main", branch), [ROLE, STEP].join("\n"));
  assert.match(git(bare, "diff", "--numstat", "main", branch, "--", ROLE), /^1\t1\t/, "a role change is one line");
  assert.match(git(bare, "diff", "--numstat", "main", branch, "--", STEP), /^1\t1\t/, "a reorder is one line");
  assert.equal(doctorCalls.at(-1)!.role, proposed[ROLE], "doctor ran on the written text");
  assert.equal(existsSync(doctorCalls.at(-1)!.cwd), false, "the temporary worktree is removed");
  assert.equal(git(checkout, "worktree", "list").split("\n").length, 1);
  const pushed = heads();

  // 8. a smoke run returns doctor's result and pushes nothing
  doctor = { code: 3, output: "warn" };
  assert.deepEqual(await runWorkflowSmoke({ repo: REPO, files: proposed }), { code: 3, output: "warn" });
  assert.equal(heads(), pushed, "no new branch");
  assert.equal(pulls.length, 1, "no new PR");

  // paths outside the workflow files, and bad input, are refused before any git call
  const calls = checkouts;
  for (const path of ["../x.toml", ".sstack/steps/../step.toml", ".sstack/project.toml", ".sstack/runs/a/plan.md", ".sstack/roles/.hidden.toml"]) {
    await assert.rejects(runWorkflowPr({ repo: REPO, files: { [path]: "x = 1\n" } }), /not a workflow file/, path);
  }
  await assert.rejects(runWorkflowPr({ repo: REPO, files: {} }), /no files/);
  await assert.rejects(runWorkflowPr({ repo: REPO, files: { [CONFIG]: 1 as unknown as string } }), /must be text/);
  assert.equal(checkouts, calls, "the checkout was never asked");
  await assert.rejects(runWorkflowPr({ repo: "acme/none", files: proposed }), /no checkout of acme\/none/);

  // files identical to main are not a PR
  doctor = { code: 0, output: "ok" };
  await assert.rejects(runWorkflowPr({ repo: REPO, files: { [CONFIG]: config } }), /nothing to save/);
  assert.equal(heads(), pushed);
  assert.equal(pulls.length, 1);
  assert.equal(git(checkout, "worktree", "list").split("\n").length, 1);

  // only admins create a PR; anyone may smoke
  assert.deepEqual([mayCreate("workflow_pr", "admin"), mayCreate("workflow_smoke", "admin")], [true, true]);
  assert.deepEqual([mayCreate("workflow_pr", "engineer"), mayCreate("workflow_smoke", "engineer")], [false, true]);

  // the default doctor reports a non-zero exit as a result, and a missing binary as an error
  const script = join(root, "doctor.sh");
  writeFileSync(script, "#!/bin/sh\necho out\necho err >&2\nexit 2\n");
  chmodSync(script, 0o755);
  process.env.SSTACK_DOCTOR = script;
  assert.deepEqual(await realDoctor(root), { code: 2, output: "out\nerr\n" });
  process.env.SSTACK_DOCTOR = join(root, "missing");
  await assert.rejects(realDoctor(root));

  // workflow canvas: chain order from `after`, a drag rewrites the fewest lines, recon and pr stay put
  const s = steps({});
  assert.deepEqual(chain(s), ["recon", "plan", "implement", "gate", "review", "pr"]);
  assert.deepEqual(chain(steps({ ".sstack/steps/plan/step.toml": "enabled = false\n" })), ["recon", "implement", "gate", "review", "pr"]);
  const dmm = steps({ ".sstack/steps/dmm/step.toml": "after = 'implement'\nrole = 'x'\n" });
  assert.deepEqual(chain(dmm), ["recon", "plan", "implement", "dmm", "gate", "review", "pr"]);

  const moved = move(s, "review", "implement");
  assert("order" in moved);
  const diff = diffLines(s, moved.after);
  assert.equal(diff.length, 2);
  assert.deepEqual(diff[0], { path: ".sstack/steps/review/step.toml", from: 'after = "gate"', to: 'after = "plan"' });
  const applied = Object.fromEntries(Object.entries(s).map(([k, v]) => [k, { ...v, after: moved.after[k] ?? v.after }]));
  assert.deepEqual(chain(applied), moved.order);
  assert.deepEqual(moved, { order: ["recon", "plan", "review", "implement", "gate", "pr"], after: { review: "plan", implement: "review" } });

  const refused = [
    ["recon", "plan"],
    ["pr", "review"],
    ["plan", "recon"],
    ["review", "pr"],
  ].map(([a, b]) => "error" in move(s, a, b));
  assert.deepEqual(refused, [true, true, true, true]);
  const gated = { [CONFIG]: '[unattended]\nplan_gate = "inbox" # review plans\n', ".sstack/roles/plan.toml": harnessModel };
  assert.deepEqual(meta(gated, s.plan), { model: "claude · opus", planGate: "Inbox" });
  assert.deepEqual(meta({}, s.pr), { model: "—" });
  assert.deepEqual([meta({ ".sstack/roles/plan.toml": 'model = "sonnet"\n' }, s.plan).model, meta({}, s.review).model], ["claude · sonnet", "default"]);
  assert.deepEqual(readToml('after = "\\u0070lan"\n"on_fail" = \'a\\b\'\n'), { after: "plan", on_fail: "a\\b" });
  assert.deepEqual(readToml('"\\u0061fter" = "plan"\nrole = "\\U00000070lan"\n'), { after: "plan", role: "plan" });
  for (const h of ['["unattended"]\nplan_gate', "[ 'unattended' ]\nplan_gate", "[unattended]\nplan_gate", "unattended.plan_gate"])
    assert.equal(meta({ [CONFIG]: `${h} = "inbox"\n` }, s.plan).planGate, "Inbox");
  const six = ["recon", "plan", "implement", "gate", "review", "pr"];
  for (const after of ['"after" = "\\u0070lan"', 'after = """plan"""']) assert.deepEqual(chain(steps({ ".sstack/steps/review/step.toml": `${after}\n` })), six);
  const bad = { ".sstack/steps/review/step.toml": "after = \n", [CONFIG]: "unattended.plan_gate =\n" };
  assert.match(tomlError(bad) ?? "", /^\.sstack\/steps\/review\/step\.toml: /);
  assert.deepEqual(chain(steps(bad)), six);
  assert.equal(meta(bad, s.plan).planGate, "Auto");

  console.log("workflow regressions passed");
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  rmSync(root, { recursive: true, force: true });
  process.exit(process.exitCode ?? 0);
}
