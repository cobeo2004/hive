# Hive

A personal Linear-to-PR software factory: a fork of marshal-factory at `999ad20`.
Spec: [docs/prd.md](../docs/prd.md) (R1–R26 by milestone, decisions, open questions).
Terms: [docs/glossary.md](../docs/glossary.md) — use its names (job, lead thread, child, stage vs phase, evidence vs media).

## What it is

Engineers assign or label a Linear issue; Hive runs coding agents on it through recon, plan,
implement and test, then opens a PR with proof it works: checks at the pushed commit plus before
and after recordings from the browser or iOS/Android simulators. People review and merge; Hive
merges on its own only where a repository allows it.

## Who it's for

- **Engineers (the owner and anyone they invite)**: hand off well-scoped issues, answer the agent's questions, review its PRs,
  connect their own Claude and ChatGPT subscriptions.
- **Admins**: connect Linear, GitHub and Slack; onboard repos; set each repo's merge mode and
  workflow; manage the team account pool and the Mac pool.

## Main flows

1. **Hand off an issue** — assign or label `hive`; the runner claims it, starts a T3 thread on
   `hive/<KEY>`, and the job appears on the Jobs board.
2. **Answer a question** — the agent posts options on Linear and in the owner's Inbox and waits; the
   answer resumes the thread.
3. **Approve a plan** (plan gate on) — Approve resumes implementation, Request changes resumes planning.
4. **Review a PR** — the job reaches PR · CI with evidence and a merge assessment; per merge mode Hive
   merges or says "Would merge" and hands over.
5. **Onboard a repository** — an onboarding agent runs sstack `setup`, records checks, opens a PR with
   `.sstack/` and `.factory/setup.json`; a warm sandbox image is built.

## Surfaces and how they connect

- **Panel** (`app/`, Next.js): Jobs, Inbox, Repositories, Machines, Settings, Workflow. Deployed on Vercel
  (`vercel.json`); Better Auth sign-in with a setup-token admin and TOTP (`lib/auth/`, `proxy.ts`).
  The owner's tailnet is an optional, opt-in layer in front of it.
- **Database and live updates**: any Postgres via Drizzle (`db/schema.ts`). Triggers notify
  `hive_changes` (`drizzle/0040_live_notify.sql`); the panel follows it over SSE (`app/api/live`,
  `components/panel/live-refresh.tsx`) and the runner with `runner/realtime.ts`.
- **Ingest** (`app/api/ingest`, `app/api/webhooks/[source]`): panel routes receiving reporter
  events and Linear/GitHub webhooks, secret- or signature-checked. The only public paths.
- **Runner** (`runner/`): the only process touching T3, git and the GitHub API; one per pool Mac.
- **Agents**: T3 Code threads on a runner Mac or in Modal sandboxes (`lib/modal-host.ts`,
  `lib/sandbox.ts`). The lead thread runs sstack `work` and dispatches roles as T3 child tasks.
- **Reporter**: `mcp/factory-report.ts` plus Claude Code hooks (`hooks/`) post stages, questions,
  evidence and spend to ingest.
- **Integrations**: GitHub App (`scripts/setup-github-app.ts`), Linear (`lib/linear.ts`), Slack (`lib/slack*.ts`).

## Deeper docs

- [The sstack wiki](wiki/index.md) — how the parts connect, why, and the traps; start at `start-here`.
- [docs/prd.md](../docs/prd.md) — requirements per milestone, each naming the files it changes.
- [docs/glossary.md](../docs/glossary.md) — one name per concept; `grill` and `work` add terms here.
- [docs/operations.md](../docs/operations.md) — how each part behaves: stages, evidence, merge
  decisions, inbox, Slack, deploys, testing.
- [playbooks/factory.md](../playbooks/factory.md) — the sstack-based factory playbook.
- [design/index.html](../design/index.html) — the eight screens; `design/screens/hive.css` is the look's source of truth.
- Decision records: none yet; settled decisions are in the PRD's "Decisions".
