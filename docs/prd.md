# Hive: product requirements

Owner: Simon Nguyen · Status: draft for `grill` · Last updated: 2026-11-10

Hive is Unibuz's internal software factory. It is a fork of [marshal-factory](https://github.com/ski043/marshal-factory) (pinned at `999ad20`, 2026-10-31) that keeps its runner, stages, evidence and merge logic and changes four things: many users instead of one owner, self-hosted with its own sign-in instead of Vercel, Neon Auth and Neon Realtime, [sstack](https://github.com/cobeo2004/sstack) instead of PStack, and per-engineer agent subscriptions. Agents run through [T3 Code](https://github.com/pingdotgg/t3code) (pinned at `965ddc1d`); skills are sstack (pinned at `6e1ab59`).

Design reference: the Hive canvas (screens for sign in, first-run setup, Jobs, Run detail, Inbox, Repositories, Settings, Workflow). The factory playbook draft is `playbooks/factory.md` in this fork.

## How agents should use this file

- **`setup`** reads "What it is" through "Surfaces and how they connect" to write `.sstack/product.md`, and links this file and [glossary.md](glossary.md) from it. Run it once in the fork root after milestone M0.
- **`grill`** runs once per milestone, not once for the whole file. Open it with "grill milestone M<n> of docs/prd.md". Problem, Constraints, Goal and Decisions below are already settled; the milestone's requirements are the plan; "Open questions" are the frontier. Its `decisions.md` is the ticket `work` runs from.
- **`work`** cites the `R#` numbers below. A requirement keeps its number for the life of this file; new ones are appended, never renumbered.
- Every requirement names the marshal-factory files it builds on. Read those first and change them; do not rebuild what marshal-factory already does.

---

## What it is

Engineers assign or label a Linear issue, and Hive runs coding agents on it through recon, plan, implement and test, then opens a pull request with proof that it works: checks at the pushed commit, plus before and after recordings from the browser or the iOS and Android simulators. People review and merge. Hive only merges on its own where a repository allows it.

## Who it's for

- **Engineers at Unibuz**: hand off well-scoped Linear issues, answer the agent's questions, review its PRs, and connect their own Claude and ChatGPT subscriptions.
- **Admins** (Simon first): connect Linear, GitHub and Slack, onboard repositories, set each repo's merge mode and workflow, manage the team account pool and the machines.

## Main flows

1. **Hand off an issue.** An engineer assigns a Linear issue to themselves (opted in) or to the Hive bot, or labels it `hive`. The runner claims it, starts a T3 thread on a `hive/<KEY>` branch, and the job appears on the Jobs board.
2. **Answer a question.** When the issue is ambiguous, the agent posts options on Linear and in the owner's Inbox, then waits. The answer resumes the same thread or a fresh one on the same branch.
3. **Approve a plan** (repos with the plan gate on). The plan lands in the Inbox; Approve resumes implementation, Request changes resumes planning.
4. **Review a PR.** The job reaches PR · CI with evidence and a merge assessment. Depending on the repo's merge mode, Hive merges it, or says "Would merge" and hands it to the owner.
5. **Onboard a repository.** An admin adds a repo; an onboarding agent runs sstack `setup`, records the checks, opens a PR with `.sstack/` and `.factory/setup.json`, and a warm sandbox image is built.

## Surfaces and how they connect

These are marshal-factory's parts (see its `docs/operations.md` § Parts), with Hive's changes.

- **Panel** (`app/`, Next.js): Jobs, Inbox, Repositories, Machines, Settings, Workflow. marshal-factory deploys it to Vercel behind Neon Auth; Hive self-hosts it (`bun run start` on a pool Mac) behind Better Auth with TOTP, optionally hidden by Tailscale (R2, R3, R33).
- **Database and live updates**: any Postgres 16+ (`db/schema.ts`, Drizzle); live updates through Postgres `LISTEN`/`NOTIFY` and one SSE route (R31), replacing Neon Realtime.
- **Ingest**: panel route handlers `/api/ingest` and `/api/webhooks/[source]` (R30), replacing the Neon Function, checking signatures. With `/api/slack/*` these are the only paths open without a session.
- **Runner** (`runner/index.ts`, `runner/ops.ts`): the only process that touches T3, git and the GitHub API. Runs on each Mac in the pool; claims jobs, launches threads, merges, cleans up.
- **Agents**: T3 Code threads on the runner Mac, or in Modal sandboxes (`lib/modal-host.ts`, `lib/sandbox.ts`). The lead thread runs sstack `work`; sstack dispatches roles to other harnesses as T3 child tasks.
- **Reporter**: the `factory-report` MCP server (`mcp/factory-report.ts`) plus Claude Code hooks (`hooks/`) post stages, questions, evidence and spend to ingest.
- **GitHub App** (`scripts/setup-github-app.ts`), **Linear** (`lib/linear.ts`, `scripts/install-webhooks.ts`), **Slack** (`lib/slack*.ts`).

## Glossary and decisions

- Glossary: [docs/glossary.md](glossary.md). `grill` and `work` add settled terms there.
- Decision records: none yet; settled decisions are in "Decisions" below.

## Deeper docs

- marshal-factory `docs/operations.md`: how each part behaves (stages, evidence, merge decisions, screenshots, inbox, Slack, deploys).
- marshal-factory `playbooks/factory.md`: the PStack-based playbook Hive replaces.
- sstack `docs/guide/` (configuration, ADEs, dispatch) and `skills/work/SKILL.md`.
- T3 Code `docs/user/devices.md`: simulators, emulators and the `agent-device` CLI.

---

## Problem

Unibuz engineers spend time on well-scoped issues (bugs with a clear repro, small features) that an agent could finish, but there is no shared way to hand one off. A person can run Claude Code or Codex on their own laptop; nobody can do it for the team, unattended, with proof it works. marshal-factory solves this for one owner on a public Vercel deployment with PStack. Unibuz needs it for every engineer, private to the company, on Simon's own skill set.

## Affected users and systems

- Engineers and admins at Unibuz.
- Unibuz repositories: `unibuz-mobile` (Expo), `unibuz-web`, `unibuz-api` first.
- Linear (Unibuz workspace), GitHub (unibuz org), Slack (Unibuz workspace), the Unibuz tailnet.
- The fork itself, sstack (one change, R14) and the runner Macs.

## Constraints

- **Fork, don't rewrite.** Change marshal-factory's existing modules behind small seams so upstream fixes still merge. Keep its tests passing: `bun run test:regressions` runs every `scripts/*-regressions.ts` against a throwaway database on any Postgres (R29, `docs/operations.md` § Testing).
- **Licence.** marshal-factory has no LICENSE file; Simon has written permission from its author (settled in M1).
- **Private by default.** Every panel page needs a signed-in Hive user with TOTP. Accounts come only from the setup token or an admin's invite, bound to an `@unibuz.com.au` email. Tailscale may additionally hide the panel.
- **Self-hostable.** Running Hive and its tests needs only Postgres; no Neon, Vercel or Tailscale account.
- **Agents never merge.** Only the runner merges, following each repo's merge mode, and it reverts a merge that turns the base branch red (marshal-factory's existing behaviour).
- **Credentials stay per person.** One engineer's subscription is never used for another's job unless it is in the team pool. Admins see usage, never tokens.
- **Pinned toolchain.** T3 Code, Claude Code, Codex, sstack and the Playwright MCP are pinned by version or commit, as marshal-factory pins them in `lib/sandbox.ts`.
- **Stack.** TypeScript and Bun, Next.js, Drizzle on Postgres, Better Auth, Modal, T3 Code. No new language or framework without a decision.

## Goal

Any Unibuz engineer can hand a Linear issue to Hive and get back a reviewable PR with proof it works, from a Hive the company hosts itself, optionally hidden on its tailnet.

## Done when

On a fresh Linear issue in `unibuz-mobile` with a reproducible iOS bug, labelled `hive` and assigned to an opted-in engineer (not Simon):

1. The job appears on that engineer's Jobs board within 60 seconds, and the panel returns no page to a request without a signed-in, TOTP-verified session.
2. The lead thread runs on that engineer's Claude subscription, with stages triage → investigating → planning → implementing → verifying → pr.
3. The PR has `factory-verify` evidence for its head commit with every check passed, and before and after iOS Simulator recordings in its description.
4. The issue moves to In Review in Linear with the PR link, and the engineer gets a Slack DM with Review buttons.

## Milestones and requirements

Each milestone is one `grill` session and one or more `work` runs, in order. "Builds on" names the marshal-factory code to change.

### M0. Fork and baseline

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R1 | The fork is marshal-factory at `999ad20` with an `upstream` remote, renamed to Hive in package name, panel title and launch messages only. Linear label default `hive`, branch prefix `hive/`. | `package.json`, `lib/config.ts` and `lib/sources/linear.ts` (`label`), `lib/factory.ts` (branch prefix, one constant used by `lib/branch-sql.ts`, `lib/worktrees.ts`, `runner/post-merge.ts`, `runner/onboarding.ts`), panel titles, runner prompts | `bun run test:regressions` passes, with only the renamed defaults changed in the scripts, except `playbook-regressions`, which stays red until R13. |

### M1. Access: many users, self-hosted

Grilled 2026-11-10; R2–R6 rewritten by that grill. Decisions: `.sstack/runs/m1-access-20261110-0056/decisions.md`.

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R2 | Self-hosted: `bun run start` on a pool Mac under a LaunchAgent; `scripts/rollout.ts` step 1 builds and restarts the panel instead of waiting for Vercel. Tailscale `serve`/Funnel in front is optional and documented; the app reads no Tailscale headers. | `scripts/rollout.ts`, `docs/operations.md`, `README.md`; `vercel.json` stays unused | Rollout brings the panel up at the new commit with no Vercel status; the docs cover the Tailscale and plain setups. |
| R3 | Identity comes from self-hosted Better Auth (Drizzle adapter, email and password) instead of Neon Auth. Sign-up is closed; invites only, for `@unibuz.com.au` emails. One `currentUser()` replaces every session read. | `proxy.ts`, `lib/auth/`, `app/auth/`, `app/api/auth/`, `components/auth/`, `app/actions/*`, `app/api/jobs/*`, `lib/new-job-deps.ts`, the owner-email allowlist variable (removed) | No session → `/auth/sign-in` (pages) or 401 (`/api/*` outside R30's public paths). Sign-up without an invite is refused. |
| R4 | Roles `admin` and `engineer` on Better Auth's user table (`admin` plugin). The setup-token user is the first admin; admins change roles in Settings → Members; the last admin can't be demoted. Members may view, file jobs and act on the inbox; Settings, Repositories edits, repo onboarding and T3 pairing are admin-only. | `db/schema.ts`, new migration, the `isOwner` checks in `lib/*` | An invited user is `engineer` and gets 403 on admin sections; demoting the only admin is refused. |
| R5 | First-run setup at `/setup` (not "onboarding"): Account → Done in M1. Account shows name, email, role, TOTP enrolment (R33) and the Slack match (R6); Done offers admins "Add a repository". | new `app/(panel)/setup`, `proxy.ts` or panel layout | A new user lands in setup once; finishing it lands on Jobs and never shows setup again. |
| R6 | Slack buttons and `/factory` work for any Hive user: the clicker's email (`users.info`, bot scope `users:read.email`) picks the Hive user the action runs as; no match → ephemeral "Sign in to Hive first". `SLACK_OWNER_USER_ID` stays only as the notification target. | `lib/slack-interactions.ts`, `lib/slack-new-job.ts`, `lib/slack-route-deps.ts`, Slack manifest | An engineer's Approve in Slack records them as the approver; an unknown Slack user records nothing. |
| R29 | The regression harness runs on any Postgres: a throwaway `hive_test_<id>` database on `TEST_DATABASE_URL`'s server, migrated and dropped per run. | `scripts/test-branch.ts`, `scripts/test-guard`, `lib/test-mode.ts`, `.sstack/project.toml` | `bun run test:regressions` passes with no `neon` CLI. |
| R30 | Ingest runs as panel routes `/api/ingest` and `/api/webhooks/[source]`, reusing the ingest handler. Only those and `/api/slack/*` skip the session; each checks its signature. `neon.ts` and every Neon package and every Neon Auth variable are removed. | `functions/ingest/index.ts`, `proxy.ts`, `neon.ts`, `package.json` | Each public path rejects an unsigned request; every other path needs a session. |
| R31 | Live updates through Postgres `LISTEN`/`NOTIFY`: triggers notify `hive_changes` with the table name; one SSE route `/api/live` (session required) tells the panel which feeds to refetch; the runner listens to wake early, its tick stays the real loop. | `lib/live-queries.ts`, `components/panel/sealed.ts`, `components/panel/realtime-root.tsx`, `app/api/live/*`, `runner/realtime.ts`, `runner/index.ts`, new migration | The board updates within 2 seconds of a stage report; the runner takes a new intent before its next tick. |
| R32 | `bun scripts/setup-token.ts` prints a one-time `/setup?token=…` link (1 hour, stored hashed, only while no admin exists); `--reset <email>` prints a one-time reset link. Admins make one-time invite links (7 days, one Unibuz email) and reset links in Settings → Members. Nothing is emailed. | new script, Settings → Members | Each link works once; the setup token is refused once an admin exists. |
| R33 | TOTP is required for every user, enrolled in setup's Account step (Better Auth `twoFactor`), backup codes shown once. | `lib/auth/`, `components/auth/credentials-form.tsx`, `/setup` | A correct password without a TOTP code reaches no panel page; a backup code works once. |

### M2. Ownership and pickup

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R7 | Pick up an issue in Todo when it has the `hive` label, or is assigned to the Hive bot user, or to an engineer who opted in. Several Linear teams allowed. | `lib/config.ts` (`teamKey` becomes a list), `lib/linear.ts`, `runner/intents.ts`, `scripts/install-webhooks.ts` | Each of the three triggers creates exactly one job; an unlabelled issue assigned to a non-opted-in engineer creates none. |
| R8 | Every job has an owner: the assignee, else the issue creator. Jobs has Everyone and Mine; the Inbox shows the signed-in user's items, with an Everyone view for admins. | `db/schema.ts` (jobs), `lib/inbox.ts`, `lib/repo-filter.ts` | Two engineers see different Inbox items for the same board. |
| R28 | First-run setup (R5) gains the Linear step: link Linear and set the pickup opt-ins (assigned to me, labelled `hive`, plan approval), as on the canvas. Added by the M1 grill. | `/setup` (R5), R7's opt-ins | Opt-ins saved in setup drive R7's pickup for that user. |

### M3. Accounts and billing

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R9 | Each engineer connects their own Claude (Pro or Max) and ChatGPT (Plus or Pro) subscription through a one-time-code sign-in. Tokens are stored per user on the runners and in Modal per user, never in Postgres in plain text and never shown in the panel. | `CLAUDE_CODE_OAUTH_TOKEN` handling, `lib/modal-secrets.ts`, `runner/codex-usage.ts` | A job owned by A never starts with B's token (unit test on credential selection). |
| R10 | A job runs on its owner's account; when that account is rate-limited, on the team pool; if the pool is above a set threshold and "pause instead" is on, the job waits. Admins manage pool accounts. | `runner/launch.ts`, `lib/settings.ts` | Simulated 429 on the owner's account relaunches on a pool account and records which account ran each attempt. |
| R11 | Usage meters per account (5-hour window and weekly) on Jobs and Settings; spend per job and attempt stays as marshal-factory measures it. | `runner/codex-usage.ts`, `lib/spend.ts`, `lib/pricing.ts` | Meters match the provider's reported usage within one refresh. |
| R27 | First-run setup (R5) gains the Agents step: connect Claude and ChatGPT with a one-time code (R9), or skip to use the team pool, as on the canvas. Added by the M1 grill. | `/setup` (R5), R9 | The step sits between Account and Done; skipping it leaves the user on the team pool. |

### M4. sstack instead of PStack

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R12 | The sandbox image and runner Macs install sstack (`sstack-install`) pinned by commit; PStack is removed from pins, image checks and Codex config. | `lib/sandbox.ts` (`PSTACK_DIR`, `PSTACK_PLUGIN`, `pinnedVersions`), `lib/sandbox-image-build.ts`, `runner/base-image.ts`, `scripts/sandbox-regressions.ts`, `scripts/base-image-regressions.ts` | Image check reports "sstack <commit>" and no PStack; regressions updated and passing. |
| R13 | `playbooks/factory.md` is the sstack-based playbook (draft in this fork), extending `work`, `bug-fix`, `feature`, `refactor`, `perf` and `babysit`. | `playbooks/factory.md`, `lib/playbook.ts` | A test thread on a fixture repo reports every stage in order and opens a PR. |
| R14 | sstack gains an unattended mode: `SSTACK_UNATTENDED=1` plus `[unattended] plan_gate = "auto" \| "inbox"` in `config.toml`. Gates behave as the playbook says. This lands in the sstack repo. | sstack `lib/sstack_config.py`, `skills/work/SKILL.md`, `docs/spec/config.md` | sstack's `python3 -m unittest discover -s tests` passes with new config tests. |
| R15 | New stage `planning` between `investigating` and `implementing`, on the board, in Linear write-back and in `report_stage`. | `lib/stages.ts` (`STAGE_TRANSITIONS`), `mcp/factory-report.ts`, `lib/linear.ts` | Transition tests cover planning; the board shows a Planning column. |
| R16 | `report_stage` accepts `waiting` with `kind: "plan_approval"` and the plan attached. It shows in the Inbox with Approve and Request changes, and resumes the thread. | `lib/inbox.ts`, `lib/inbox-actions.ts`, `lib/resume.ts`, `runner/inbox.ts` | Approve resumes at Phase 2; Request changes resumes at Phase 1 with the note. |
| R17 | `factory-verify` runs `.sstack/project.toml`'s `verify` list when present, else the recorded recipe, else `package.json` scripts. Trusted commands are the ones recorded at onboarding. | `hooks/verify.ts`, `lib/recipe.ts`, `lib/trusted-checks.ts`, `lib/evidence.ts` | A PR that edits `verify` to `true` gets `untrusted` evidence. |
| R18 | Repository onboarding runs sstack `setup` (unattended) to write `.sstack/product.md` and `project.toml`, keeps `.factory/setup.json` for runtimes, install and secret names, and opens one PR with both. | `lib/repo-onboarding.ts`, `playbooks/onboarding.md`, `runner/onboarding.ts` | Onboarding a fixture repo opens a PR containing both files and the repo reaches Ready. |
| R19 | Children dispatched by sstack show in the job's Lineage with harness, model, role and duration, from `.sstack/runs/index.jsonl`, and their cost counts toward the job's spend where it can be read. | `lib/spend.ts`, `lib/transcript.ts` | A job with an implement child on pi shows that child in Run detail. |

### M5. Workflow configuration

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R20 | The Workflow screen edits a repo's `.sstack/roles/*.toml` and `config.toml` through a PR, and Hive-wide defaults in `~/.sstack` on every runner. Each save runs `sstack-doctor`; a failing config is not saved. | new screen; `lib/settings.ts` keeps only the lead thread's harness and model | Changing implement to codex in the UI opens a PR whose diff is that one TOML line. |
| R21 | The lead thread's harness must report stages (Claude Code or Codex). A Linear `Harness` label still overrides the lead for one ticket. | `lib/harness.ts` (`trackingOf`), `lib/ticket-overrides.ts` | Choosing Cursor as lead is refused with the reason. |

### M6. Devices and evidence

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R22 | Jobs in repos with `[test.mobile]` run on the Mac pool with T3 devices; Modal runs web and API jobs. | `lib/execution.ts`, `lib/host.ts`, `lib/modal-host.ts` | A mobile job is never placed on Modal. |
| R23 | The `pr` assessment accepts `media` (png, jpg, webp, mp4, mov) from `<run>/media/`, up to six, replacing the Playwright-only `screenshots`. The UI-files handover rule counts media. | `lib/screenshots.ts` (`SCREENSHOT_DIR`, `UI_GLOBS`), `lib/screenshot-files.ts`, `mcp/factory-report.ts`, `job_screenshots` | A UI PR with a video and no images is not handed over for missing screenshots. |
| R24 | PR descriptions carry a Before and After table from `sstack-pr-media`, stored where Open Q3 decides. | `lib/assessment.ts`, sstack `bin/sstack-pr-media` | The PR body has the marked `sstack-media` section with working media. |

### M7. Panel

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R25 | The panel matches the Hive canvas: sidebar with running jobs, breadcrumb bar, dark by default, Unibuz blue for selection and lime only for PR ready. Routes stay marshal-factory's. | `app/(panel)/`, `components/` (shadcn), `app/globals.css` | Each canvas screen has a matching route; light and dark both pass WCAG AA for text. |
| R26 | Run detail shows the live T3 device the agent is driving, the thread log, the timeline, Lineage, evidence and the merge decision. | run detail route, `lib/run-links.ts`, `lib/t3-client.ts` | A running mobile job shows its device view to its owner. |

---

## Decisions

Settled; `grill` does not reopen these.

- Hive is a fork of marshal-factory, not a rewrite.
- Agents run through T3 Code. Harnesses: Claude Code and Codex for the lead; any T3 provider for dispatched roles.
- Skills are sstack, not PStack. Per-role routing uses sstack's own `.sstack/roles/*.toml`; there is no separate Hive workflow file.
- Access is Hive's own: Better Auth with password and required TOTP, accounts only by setup token or invite, Unibuz emails only. Tailscale may hide the panel but is optional (M1 grill, replacing "Tailscale-only, no passwords").
- Self-hostable: any Postgres, no Neon, Vercel or Tailscale account required (M1 grill).
- Billing: owner's subscription first, team pool second.
- Merge modes stay marshal-factory's `off`, `trial` and `auto` per repository.
- UI follows T3 Code's look with Unibuz accents.
- Images and videos may be public (to render in GitHub and Linear); everything else needs a signed-in user or a signature.

## Out of scope

- Accounts for non-Unibuz emails.
- Issue sources other than Linear.
- Agents merging, force-pushing or pushing to a base branch.
- Editing workflows from Slack.
- Windows or Linux runners for mobile jobs.

## Open questions

The frontier for `grill`, each with a recommendation.

1. **Panel hosting.** Settled in M1: self-hosted on a pool Mac, Tailscale optional (R2).
2. **Database.** Settled in M1: any Postgres; Realtime and Functions replaced (R30, R31).
3. **Where PR media lives.** A media branch in the same repo (`sstack-pr-media`, visible only to repo members, not shown in Linear) or a public bucket with unguessable links? → Media branch for PRs, and a Linear comment that links the PR instead of embedding media.
4. **Subscription terms.** Can personal Claude and ChatGPT subscriptions run jobs on shared, unattended runners? → Check both providers' terms before M3; if not allowed, the team pool uses API keys.
5. **Where per-user tokens live.** macOS Keychain per user on each runner, Modal secrets per user, or both? → Both, written by the setup flow, never stored in Postgres.
6. **Plan gate default.** `auto` or `inbox` for new repos? → `inbox` while a repo is on `trial`, `auto` once it moves to `auto` merging.
7. **Licence.** Settled in M1: Simon has written permission from ski043.
8. **Upstream.** Contribute multi-user (M1 and M2) back to marshal-factory, or keep it in the fork? → Offer it upstream; keep Unibuz specifics in the fork. M1 decided not to open the PR before M2 is done.
11. **Repo-notes path.** Keep per-repo notes at `.agents/playbooks/factory.md` or move them to `.sstack/playbooks/factory.md`? → Decide in M4 with R13 and R18.
12. **Machines page.** Its own page or a Settings section as on the canvas? → Own page until R25 (M7).
9. **Mac pool.** How many Macs, and do simulators run on the host or in macOS VMs? → Two Mac minis, simulators on the host through T3 devices, three jobs per Mac.
10. **Linear setup.** Which teams, and does Hive get a bot user? → Mobile, Web and Platform teams; yes, a `Hive` bot user so "assign to Hive" works.
