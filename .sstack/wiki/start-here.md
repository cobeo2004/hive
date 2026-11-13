---
summary: Map of hive's moving parts and which page to open for each kind of task
updated: 3588135
---

# Start here

Hive turns a Linear issue into a PR. Job execution belongs to the runner (`runner/`, one per pool
Mac): it alone runs T3 threads, git and sandboxes. The panel (`app/`) reads and writes Postgres, and
its admin actions also call integrations directly: GitHub for the add-repo list and Rebuild
(`app/actions/repositories.ts:38`, `:102`) and Modal to save repo secrets (`:85`). The two talk through
rows: the panel writes `intents`, the runner takes them, agents report back through ingest.

| Task touches | Open |
|---|---|
| Pickup, claim, stages, PR, merge | [job-lifecycle](job-lifecycle.md) |
| Why a page refreshes (or doesn't) | [live-updates](live-updates.md) |
| Claude/Codex/Cursor accounts, the pool, sealed tokens | [accounts-and-credentials](accounts-and-credentials.md) |
| Modal sandboxes, the base and warm images, hibernate/wake | [sandboxes-and-image](sandboxes-and-image.md) |
| `factory-verify`, evidence states, merge modes | [evidence-and-merge](evidence-and-merge.md) |
| Sign-in, TOTP, admin vs engineer, cookies | [auth-and-access](auth-and-access.md) |
| Running regressions, fakes, the test DB | [testing](testing.md) |
| Adding a repository, recipes, warm image builds | [repo-onboarding](repo-onboarding.md) |

Product overview: [product.md](../product.md). Requirements: `docs/prd.md`. Names: `docs/glossary.md`.
