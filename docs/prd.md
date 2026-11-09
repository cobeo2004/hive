# Hive: product requirements

Owner: Simon Nguyen · Status: draft for `grill` · Last updated: 2026-11-09

Hive is Unibuz's internal software factory. It is a fork of [marshal-factory](https://github.com/ski043/marshal-factory) (pinned at `999ad20`, 2026-10-31) that keeps its runner, stages, evidence and merge logic and changes four things: many users instead of one owner, Tailscale instead of a public panel, [sstack](https://github.com/cobeo2004/sstack) instead of PStack, and per-engineer agent subscriptions. Agents run through [T3 Code](https://github.com/pingdotgg/t3code) (pinned at `965ddc1d`); skills are sstack (pinned at `6e1ab59`).

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

- **Panel** (`app/`, Next.js): Jobs, Inbox, Repositories, Machines, Settings, Workflow. marshal-factory deploys it to Vercel behind Neon Auth; Hive serves it on the Unibuz tailnet only (R2, R3).
- **Database and live updates**: Neon Postgres (`db/schema.ts`, Drizzle) with Neon Realtime (`lib/live-queries.ts`, `runner/realtime.ts`).
- **Ingest** (`functions/`): Neon Functions that receive Linear and GitHub webhooks and reporter events, checking signatures. This is Hive's only public surface.
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

- **Fork, don't rewrite.** Change marshal-factory's existing modules behind small seams so upstream fixes still merge. Keep its tests passing: `bun run test:regressions` runs every `scripts/*-regressions.ts` against a throwaway Neon branch (`docs/operations.md` § Testing).
- **Licence.** marshal-factory's author agreed to this use, but the repo has no LICENSE file. Hive must not ship until a licence is in the repo or written permission is on file (Open Q7).
- **Private by default.** The panel is reachable only over the Unibuz tailnet. Only `@unibuz.com.au` Tailscale logins in the allowed tailnet group get in.
- **Agents never merge.** Only the runner merges, following each repo's merge mode, and it reverts a merge that turns the base branch red (marshal-factory's existing behaviour).
- **Credentials stay per person.** One engineer's subscription is never used for another's job unless it is in the team pool. Admins see usage, never tokens.
- **Pinned toolchain.** T3 Code, Claude Code, Codex, sstack and the Playwright MCP are pinned by version or commit, as marshal-factory pins them in `lib/sandbox.ts`.
- **Stack.** TypeScript and Bun, Next.js, Drizzle on Neon Postgres, Neon Realtime and Functions, Modal, T3 Code. No new language or framework without a decision.

## Goal

Any Unibuz engineer can hand a Linear issue to Hive and get back a reviewable PR with proof it works, without anything leaving the company tailnet except signed webhooks and PR media.

## Done when

On a fresh Linear issue in `unibuz-mobile` with a reproducible iOS bug, labelled `hive` and assigned to an opted-in engineer (not Simon):

1. The job appears on that engineer's Jobs board within 60 seconds, opened over the tailnet, and the panel returns no page to a request from outside the tailnet.
2. The lead thread runs on that engineer's Claude subscription, with stages triage → investigating → planning → implementing → verifying → pr.
3. The PR has `factory-verify` evidence for its head commit with every check passed, and before and after iOS Simulator recordings in its description.
4. The issue moves to In Review in Linear with the PR link, and the engineer gets a Slack DM with Review buttons.

## Milestones and requirements

Each milestone is one `grill` session and one or more `work` runs, in order. "Builds on" names the marshal-factory code to change.

### M0. Fork and baseline

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R1 | The fork is marshal-factory at `999ad20` with an `upstream` remote, renamed to Hive in package name, panel title and launch messages only. Linear label default `hive`, branch prefix `hive/`. | `package.json`, `lib/config.ts` and `lib/sources/linear.ts` (`label`), `lib/factory.ts` (branch prefix, one constant used by `lib/branch-sql.ts`, `lib/worktrees.ts`, `runner/post-merge.ts`, `runner/onboarding.ts`), panel titles, runner prompts | `bun run test:regressions` passes, with only the renamed defaults changed in the scripts, except `playbook-regressions`, which stays red until R13. |

### M1. Access: Tailscale and many users

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R2 | The panel is served only over the tailnet (`tailscale serve` on a pool Mac), listening on localhost. | `next.config.ts`, deploy docs; Vercel deploy dropped (Open Q1) | A request from a non-tailnet host gets no response; from the tailnet it returns Jobs. |
| R3 | Identity comes from the `Tailscale-User-Login` header instead of Neon Auth. Allowed: logins ending `@unibuz.com.au`. Others see "Use your Unibuz account"; tailnet users outside the group see "You don't have access yet". | `proxy.ts`, `lib/auth/`, `FACTORY_OWNER_EMAILS`, `app/auth/` | A request with a gmail login renders the wrong-account page; with a Unibuz login it renders Jobs. The header is ignored on any request not from localhost. |
| R4 | A `users` table with role `admin` or `engineer`. The first user to sign in is admin; admins change roles in Settings. | `db/schema.ts`, new migration | Second sign-in gets `engineer`; an engineer cannot open admin Settings sections (403). |
| R5 | First-run setup for each new user: Account, Agents, Linear, then done, as on the canvas. | new `app/(panel)/onboarding` | A new user lands in setup once; finishing it lands on Jobs and never shows setup again. |
| R6 | Slack buttons work for any user, acting as the Slack user's matched Hive user, not only the owner. | `lib/slack-interactions.ts`, `lib/slack-request.ts` | An engineer's Approve in Slack records them as the approver. |

### M2. Ownership and pickup

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R7 | Pick up an issue in Todo when it has the `hive` label, or is assigned to the Hive bot user, or to an engineer who opted in. Several Linear teams allowed. | `lib/config.ts` (`teamKey` becomes a list), `lib/linear.ts`, `runner/intents.ts`, `scripts/install-webhooks.ts` | Each of the three triggers creates exactly one job; an unlabelled issue assigned to a non-opted-in engineer creates none. |
| R8 | Every job has an owner: the assignee, else the issue creator. Jobs has Everyone and Mine; the Inbox shows the signed-in user's items, with an Everyone view for admins. | `db/schema.ts` (jobs), `lib/inbox.ts`, `lib/repo-filter.ts` | Two engineers see different Inbox items for the same board. |

### M3. Accounts and billing

| # | Requirement | Builds on | Check |
|---|---|---|---|
| R9 | Each engineer connects their own Claude (Pro or Max) and ChatGPT (Plus or Pro) subscription through a one-time-code sign-in. Tokens are stored per user on the runners and in Modal per user, never in Postgres in plain text and never shown in the panel. | `CLAUDE_CODE_OAUTH_TOKEN` handling, `lib/modal-secrets.ts`, `runner/codex-usage.ts` | A job owned by A never starts with B's token (unit test on credential selection). |
| R10 | A job runs on its owner's account; when that account is rate-limited, on the team pool; if the pool is above a set threshold and "pause instead" is on, the job waits. Admins manage pool accounts. | `runner/launch.ts`, `lib/settings.ts` | Simulated 429 on the owner's account relaunches on a pool account and records which account ran each attempt. |
| R11 | Usage meters per account (5-hour window and weekly) on Jobs and Settings; spend per job and attempt stays as marshal-factory measures it. | `runner/codex-usage.ts`, `lib/spend.ts`, `lib/pricing.ts` | Meters match the provider's reported usage within one refresh. |

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
- Access is Tailscale-only, Unibuz emails only. No passwords.
- Billing: owner's subscription first, team pool second.
- Merge modes stay marshal-factory's `off`, `trial` and `auto` per repository.
- UI follows T3 Code's look with Unibuz accents.
- Images and videos may be visible outside the tailnet (to render in GitHub and Linear); everything else stays inside it.

## Out of scope

- Access from outside the tailnet, or for non-Unibuz accounts.
- Issue sources other than Linear.
- Agents merging, force-pushing or pushing to a base branch.
- Editing workflows from Slack.
- Windows or Linux runners for mobile jobs.

## Open questions

The frontier for `grill`, each with a recommendation.

1. **Panel hosting.** Vercel (marshal-factory's default) or a pool Mac behind `tailscale serve`? → A pool Mac. Keep Neon Functions public for webhooks only.
2. **Database.** Keep Neon Postgres, Realtime and Functions, or self-host? → Keep Neon. marshal-factory depends on Realtime and Functions throughout.
3. **Where PR media lives.** A media branch in the same repo (`sstack-pr-media`, visible only to repo members, not shown in Linear) or a public bucket with unguessable links? → Media branch for PRs, and a Linear comment that links the PR instead of embedding media.
4. **Subscription terms.** Can personal Claude and ChatGPT subscriptions run jobs on shared, unattended runners? → Check both providers' terms before M3; if not allowed, the team pool uses API keys.
5. **Where per-user tokens live.** macOS Keychain per user on each runner, Modal secrets per user, or both? → Both, written by the setup flow, never stored in Postgres.
6. **Plan gate default.** `auto` or `inbox` for new repos? → `inbox` while a repo is on `trial`, `auto` once it moves to `auto` merging.
7. **Licence.** → Ask ski043 to add a LICENSE file (MIT or Apache-2.0) before M1 ships.
8. **Upstream.** Contribute multi-user (M1 and M2) back to marshal-factory, or keep it in the fork? → Offer it upstream; keep Tailscale and Unibuz specifics in the fork.
9. **Mac pool.** How many Macs, and do simulators run on the host or in macOS VMs? → Two Mac minis, simulators on the host through T3 devices, three jobs per Mac.
10. **Linear setup.** Which teams, and does Hive get a bot user? → Mobile, Web and Platform teams; yes, a `Hive` bot user so "assign to Hive" works.
