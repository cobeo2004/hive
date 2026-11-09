---
extends: work, bug-fix, feature, refactor, perf, babysit
when: Resolving one Linear issue unattended on a `hive/<KEY>` branch that Hive started, where the first message carries the issue and SSTACK_UNATTENDED=1 is set.
---

# Hive factory run

This playbook ships with Hive, not with the repository; the first message names its path on this machine. It changes sstack's bundled `work` skill and playbooks the way a repo playbook under `.sstack/playbooks/` does, so open the bundled ones it extends and apply the changes below. A repository's `.sstack/playbooks/factory.md` may add notes about that repository; where it differs from this one, this one wins.

No human reads this thread while it runs. The Hive panel, the Linear issue and the pull request are the only outputs anyone sees. The branch name carries the issue key: `hive/UNI-482` works issue `UNI-482`. The issue title, body and URL are in the first message.

## Standing rules

- **Report every stage.** Call `report_stage` on the `factory-report` MCP server each time the run enters a stage, before doing that stage's work. In order: `triage`, `investigating`, `planning`, `implementing`, `verifying`, `pr`. Off the main path: `waiting` and `failed`. The summary is one or two plain sentences about this issue, not about the process.
- **Every gate is yours or Hive's, never a person's in this thread.** No `AskUserQuestion`, no plan-mode approval prompt, no question that waits for a reply in the thread. Nobody answers. Gates pass as described in "Gates in an unattended run". Treat the run as a full-autonomy grant for every reversible step.
- **Blocked or ambiguous means `waiting`.** When the issue does not say what done looks like, or something outside the repo blocks you, call `report_stage` with `stage: "waiting"`, what you found, and a `question` the reporter can answer in one reply. Name each decision you need and offer two or three concrete options for each. Then end the turn. Do not guess, and do not open a PR for a guess.
- **Never merge.** Never run `gh pr merge`, never arm auto-merge, never push to the base branch, never force-push. The run ends at a merge-ready PR reported with a merge assessment. Hive decides whether it merges or goes to a person.
- **Children never commit.** Routed children (`sstack-dispatch`) write files only. You commit, push and open the PR. Bring a worktree child's diff into this checkout before Phase 3, as `work` says.
- **Clean up only what you started.** Other runs share this machine, its simulators and its ports. Start dev servers on a free port and stop the PID you started before the turn ends. Shut down a simulator or emulator only if you booted it. Never `pkill` or `killall` by name.
- **Prove the commit you ship.** Before you report `pr`, run `factory-verify` in this worktree on the final pushed commit, with nothing uncommitted. It runs `.sstack/project.toml`'s `verify` list at `HEAD` and reports exit codes for that exact commit. Hive only merges a head whose checks passed there. If you push again, run it again.
- **Show what you change.** For a change a user can see, follow sstack's `testing.md` on the surfaces `[test.*]` names: drive the page in T3's browser or the app in T3's device panel, and save `before-<step>` and `after-<step>` media in `<run>/media/`. Without media, Hive hands a UI change to a person.
- **Giving up means `failed`.** A third fix round on the same failure, a broken toolchain or a dead end: call `report_stage` with `stage: "failed"` and the reason, then end the turn.

## Gates in an unattended run

SSTACK_UNATTENDED=1 is set, and `.sstack/config.toml` `[unattended]` holds the plan gate setting.

- **Gate 0 (recon):** passes when `recon.md` is written and every heading has content or says plainly what you could not verify. Do not wait for a reader.
- **Gate 1 (plan):** with `plan_gate = "auto"`, you approve your own plan only when every `R#` has at least one check in `answer-key.md`; an uncovered requirement means `waiting` with the requirement named. With `plan_gate = "inbox"`, call `report_stage` with `stage: "waiting"`, `kind: "plan_approval"`, and `plan.md` and `answer-key.md` attached, then end the turn. Hive resumes the thread with the approval or the requested changes.
- **Gate 3 (tests and review):** passes when every answer-key check is green and no Important finding is open. An Important finding you believe is wrong stays open; note it for the assessment instead of overriding it.
- **Gate 4 (commit, push, PR):** always passes. This run is the standing request to open the PR.

## Triage

1. Call `report_stage` with `stage: "triage"`.
2. Let the `sstack` router pick the playbook from the issue text: a described symptom that differs from stated expected behaviour is `bug-fix`; new behaviour is `feature`; `refactor` and `perf` as the router decides.
3. Create the run directory as `work` says, with `run-id` = `<KEY>-<YYYYmmdd-HHMM>`. If one already exists for this key, this is a resumed run: see "Resumed runs".
4. Test for ambiguity before any code. Write `R1..Rn` from the issue text alone, each with a falsifiable done. If you cannot, the issue is ambiguous: report `waiting` with the question and stop. Do not run `grill`: it needs a person in the thread.
5. Work in this thread's worktree on the current branch. Do not create other branches for the PR.

## Resumed runs

A run that stopped in `waiting` resumes when someone answers on Linear or in the Hive Inbox. Hive sends this thread a message that quotes your question and the answer, or starts a fresh thread on the same branch with both in its first message.

1. Read the run directory's `progress.md`, `plan.md` and latest reports, and check `git status` and `git log` against them, as `work`'s Resume says.
2. The answer is the spec. Where it picks an option you offered, build that option and nothing the reporter did not ask for. Where it adds a request, add an `R#` for it.
3. A plan approval resumes at Phase 2. Requested plan changes resume at Phase 1. Anything else resumes at Triage: call `report_stage` with `stage: "triage"` and keep the branch and its commits.
4. Still unable to write a falsifiable done: report `waiting` once more with one concrete question about what is still open, and end the turn.

## Merge conflicts

When Hive tells this thread that its PR conflicts with the base branch, the board has already moved the run back to Implementing.

1. `git fetch origin` and `git merge origin/<base>` on this branch. Never rebase a pushed branch and never force-push it.
2. Resolve each conflict so both changes keep working. Read the base branch's commit to learn what it meant. Do not drop either side to make the conflict go away.
3. Call `report_stage` with `stage: "verifying"`, rerun the answer key and `factory-verify`, and recheck any changed screen.
4. Commit the merge, push, babysit to green, then report `pr` with a fresh assessment and end the turn.
5. If the two changes contradict each other and the issue does not say which wins, `git merge --abort`, report `waiting` with a question that names both changes, and end the turn.

## Merge assessment

Every run ends one of three ways: Hive merges it, Hive hands it to a person, or you asked before building (`waiting`).

1. Write down how you read the issue and every assumption you filled a gap with. Put them in the PR body under `Assumptions I made`, one bullet each; Hive copies them to Linear.
2. Recommend `merge` only when you are confident you built what the requirements ask and the answer key proves it works, with no open Important finding.
3. Recommend `handover` when you are not confident: unsure what the issue meant, unsure about an assumption, an Important finding you disagree with, or you could not show the change works. Say why in one or two sentences.

When you report `pr`, pass `assessment` with `recommendation`, `interpretation`, `assumptions`, `confidence` (`confident`, plus `reason` when not), and `notes` for anything else. Add `media`: up to six files from `<run>/media/`, each with a `caption` saying what it shows and what to look for. Be honest: Hive checks CI, conflicts and review bots itself and holds the head to what `factory-verify` reported. A `merge` it cannot back up costs trust.

## Changes to the bundled skills

### work

- **Before** Phase 0 step 1, call `report_stage` with `stage: "investigating"`.
- **Replace** step 3 of Phase 0 ("No falsifiable definition of done … run `grill` first") with: The requirements written in Triage are the definition of done. If one is still not falsifiable after recon, report `waiting` and stop.
- **Replace** "**Gate 0:** the user reads the report. Don't plan until they respond." with: Gate 0 as in "Gates in an unattended run".
- **Before** Phase 1 step 1, call `report_stage` with `stage: "planning"`.
- **Replace** "**Gate 1:** the harness's plan approval …" with: Gate 1 as in "Gates in an unattended run".
- **Before** Phase 2's first dispatch, call `report_stage` with `stage: "implementing"`.
- **Replace** "if it fails again, stop and ask" in Phase 3's loop guard with: if it fails again, report `failed` with the failing command and its output.
- **Before** Phase 3 step 1, call `report_stage` with `stage: "verifying"`.
- **Replace** "every Important finding fixed or agreed out of lane by the user" with: every Important finding fixed, or left open and named in the assessment as the reason for `handover`.
- **In** Phase 4 step 2, merge the base branch instead of rebasing a pushed branch.
- **Replace** "**Gate 4:** the user's explicit yes before commit, push or PR, and before publishing media." with: Gate 4 as in "Gates in an unattended run". Commit with Conventional Commits prefixed by the issue key, as in `UNI-482 fix(linking): replay the pending invite link after auth restores`. Start the PR body with `Linear: [UNI-482](<issue url>)`.
- **After** `sstack-pr-media <pr> <run>/media/* --edit-body`, start `babysit` on that PR right away.
- **Skip** the closing `reflect` step. Hive collects corrections from the Inbox and runs `reflect` itself.

### bug-fix

- **Replace** "Ask the user only with a specific reason you can't reach it, after going as far as you can." with: If T3's browser or device panel cannot reach the target after you drove it as far as it goes, report `waiting` with the reason and the exact repro you need, then stop.
- **Replace** "when it's cheap to write" in step 5 with: always. The failing repro is mandatory in a factory run; if no test can express the bug, report `waiting` and say why.
- **After** step 8's ordering rule, commit the failing test on its own, then the fix in a second commit.
- **Skip** step 4 (diagnose-only exit) unless the issue asks only for the cause; then report `pr` without a PR, with the diagnosis as `notes`.

### babysit

- **Replace** "Pushing needs the user's yes" and the force-push rule with: push plain commits to this `hive/` branch without asking; never force-push.
- **Replace** every "ask the user" and "ask by default" with: report `waiting` with the item and two or three options, then end the turn.
- **Run** the watcher in the foreground and rerun it until it returns a verdict. No `/loop`, no scheduled wakeups: once the turn ends, nothing wakes this thread.
- **When** the watcher reports `READY`, or a person's approval is the only blocker left, run `factory-verify` on the pushed head, then call `report_stage` with `stage: "pr"`, the `prUrl`, the CI and review state, and your merge assessment. End the turn. Three failed fix rounds on the same CI failure or bot finding: report `failed` with the PR URL.
