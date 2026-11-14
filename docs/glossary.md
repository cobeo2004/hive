# Hive glossary

One name per thing. `grill` and `work` add settled terms here. Terms marked (marshal-factory) mean exactly what marshal-factory's `docs/operations.md` means by them.

**Job** (marshal-factory): one Linear issue Hive is working, with its branch `hive/<KEY>`, attempts, evidence and PR.
_Avoid_: task, ticket (a ticket is the Linear issue itself), run.

**Attempt** (marshal-factory): one try at a job on its own branch (`hive/ENG-7-a2` for the second). A retry is a new attempt.
_Avoid_: retry run, rerun.

**Owner**: the user a job belongs to. The issue's assignee, else its creator. The owner's subscriptions run the job and the owner's Inbox gets its questions.
_Avoid_: requester, user (too broad).

**Lead thread**: the T3 thread that runs sstack `work` for a job, reports stages and opens the PR. One per attempt.
_Avoid_: main session, orchestrator, agent (too broad).

**Child**: work the lead thread dispatches to a role through `sstack-dispatch`; inside T3 it is a child task. Children never commit.
_Avoid_: subagent (that is Claude Code's own feature), worker.

**Role** (sstack): `scout`, `investigate`, `plan`, `implement` or `review`. Each maps to a harness and model in `.sstack/roles/<role>.toml`.
_Avoid_: step, stage (a stage is the job's state).

**Harness**: an agent CLI as a T3 provider: Claude Code (`claudeAgent`), Codex (`codex`), Cursor, pi, and others T3 supports.
_Avoid_: model (a harness offers models), provider (T3's word, fine in code only).

**Stage** (marshal-factory): where a job is: `triage`, `investigating`, `planning`, `implementing`, `verifying`, `pr`, off the main path `waiting` and `failed`. Reported by the lead thread through `report_stage`.
_Avoid_: phase (that is sstack `work`'s Phase 0 to 4), status.

**Phase** (sstack): a part of `work`: Recon, Plan, Implement, Test/fix, PR. Phases map onto stages.
_Avoid_: stage.

**Gate** (sstack): the stop at the end of a phase. In an unattended run, Hive or the lead passes it instead of a person, except the plan gate when set to `inbox`.
_Avoid_: checkpoint, approval (approval is one way a gate passes).

**Unattended run**: a lead thread started by Hive with `SSTACK_UNATTENDED=1`. Nobody reads the thread; questions go to Linear and the Inbox.
_Avoid_: headless (sstack uses headless for a CLI dispatch without an ADE).

**Inbox** (marshal-factory): what is waiting on a person: questions, plan approvals, PRs to review, failures. Per user in Hive.
_Avoid_: notifications, queue.

**Evidence** (marshal-factory): what checks ran at which commit, with exit codes, recorded by `factory-verify` or the runner. "Verified at head" means every required check passed for the PR's exact head commit from a clean tree.
_Avoid_: test results (too narrow), proof.

**Media**: before and after screenshots and recordings saved under `.sstack/runs/<run>/media/` and attached to the PR. Media shows the change; evidence proves it.
_Avoid_: screenshots (only one kind of media), artifacts.

**Merge mode** (marshal-factory): per repository, `off`, `trial` or `auto`. `trial` says "Would merge" and hands over; `auto` merges when confident and verified at head. The panel shows `auto` as "When confident".
_Avoid_: auto-merge (GitHub's feature, which Hive never arms).

**Recipe** (marshal-factory): `.factory/setup.json`, the runtimes, install steps and secret names a sandbox needs. Checks live in `.sstack/project.toml` `verify`.
_Avoid_: setup script, config.

**Runner** (marshal-factory): the process on each pool Mac that claims jobs and touches T3, git and GitHub.
_Avoid_: agent, worker, daemon.

**Mac pool**: the Macs running runners and T3, where mobile jobs and simulators run.
_Avoid_: machines (the panel page name, fine there), servers.

**Sandbox** (marshal-factory): a Modal container that runs one job's T3 thread for web and API work.
_Avoid_: VM, container (fine in code only).

**Team pool**: subscription accounts admins add for jobs whose owner has none, or whose own account is rate-limited.
_Avoid_: shared account, org account.

**Upstream**: marshal-factory (`ski043/marshal-factory`), the `upstream` remote Hive forked at `999ad20` and keeps merging fixes from. Each Hive-specific value (name, label, branch prefix) lives in one place, so the fork's diff in upstream's files stays small.
_Avoid_: origin (that is `cobeo2004/hive`), base (a PR's base branch).

**Branch prefix**: `hive/`, the namespace for every branch the runner pushes: attempt branches (`hive/<KEY>`, `hive/<KEY>-a2`), `hive/revert-<N>` and `hive/onboarding`. One constant, `BRANCH_PREFIX` in `lib/factory.ts`.
_Avoid_: namespace, branch naming.

**Hive label**: the Linear label (`hive` by default, `FACTORY_LABEL` / `factory.label` to override) that hands an issue to Hive. Also tags its Modal sandboxes.
_Avoid_: factory label, trigger label.

**Member**: anyone with a Hive account, admin or engineer. Members view everything, file jobs and act on the Inbox.
_Avoid_: owner (a job's owner is a separate idea), user (too broad in code), operator.

**Admin**: a member with role `admin`. Admins alone change Settings, Members, Repositories and T3 pairing. The setup-token user is the first one, and the last one can't be demoted.
_Avoid_: owner, superuser.

**Engineer**: a member with role `engineer`, the default for an invited account.
_Avoid_: developer, user.

**First-run setup**: the `/setup` steps every new member goes through once before Jobs: Account and Done in M1, with Linear (R28) and Agents (R27) added later. An admin also gets Sources ("Where do jobs come from?": Linear, GitHub Issues or both, R13); when GitHub Issues is the only source nobody gets the Linear step (R14).
_Avoid_: onboarding (that means repository onboarding), wizard.

**Setup token**: the one-time link `bun scripts/setup-token.ts` prints. It creates the first admin and is refused once an admin exists. With `--reset <email>` the script makes a password-reset link instead.
_Avoid_: bootstrap key, admin password.

**Invite**: a one-time link an admin makes in Settings → Members. It is bound to one email, valid for 7 days, and the only way to get an account after the first admin. Hive never emails it.
_Avoid_: sign-up (it's closed), access request.

**Public paths**: the only routes that answer without a session, each checking its own signature: `/api/ingest` (reporter Bearer), `/api/webhooks/*` (Linear or GitHub HMAC) and `/api/slack/*` (Slack signature). When Tailscale hides the panel, Funnel exposes only these.
_Avoid_: public API, open routes.

**Live updates**: Postgres `NOTIFY hive_changes` from table triggers, delivered to the panel through the `/api/live` SSE route and to the runner through `LISTEN`. A nudge to refetch; the runner's tick stays the real loop.
_Avoid_: realtime (that was Neon Realtime), push, websocket.
