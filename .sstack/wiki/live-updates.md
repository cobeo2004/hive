---
summary: pg NOTIFY hive_changes drives panel SSE refreshes and the runner; which tables are followed
paths: drizzle/0040_live_notify.sql, lib/listen.ts, app/api/live/**, components/panel/live-refresh.tsx, runner/realtime.ts, runner/index.ts, lib/live-mode.ts
updated: 3588135
---

# Live updates

- Statement-level triggers `pg_notify('hive_changes', <table>)`, only when rows changed: a zero-row
  UPDATE would otherwise wake the runner into the same UPDATE again (`drizzle/0040_live_notify.sql:1-11`).
- Followed: jobs, runs, agents, events, intents, machines, job_evidence, audit_log (0040),
  repo_sstack_config, sstack_defaults (0044), device_frames (0045).
- `listen()` uses `DATABASE_URL_UNPOOLED` because a pooler can't hold LISTEN (`lib/listen.ts:7-12`).
- `/api/live` sends table names only, never rows; the page re-reads through its own owner-checked
  queries (`app/api/live/route.ts:9-12`). `LiveRefresh` calls `router.refresh()` at most every 300 ms.
- The runner reconnects with backoff; its tick is still the real loop, so a gap only delays work
  (`runner/realtime.ts:10-47`). It reacts to `intents` and `jobs` only.

## Traps

- `repo_settings`, `agent_accounts`, `account_logins` and `settings` have no trigger. The
  Repositories page polls every 10 s while a repo is moving (`components/panel/repo-onboarding.tsx:31-51`).
- A new followed table needs a migration adding all three triggers (insert, update, delete).
- One PG connection per open tab; previews turn live updates off (`next.config.ts:9`).

Related: [job-lifecycle](job-lifecycle.md), [repo-onboarding](repo-onboarding.md).
