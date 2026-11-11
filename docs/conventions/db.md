# Database and migrations

Applies to `db/**` and `drizzle/**`. Both are held files (`never_merge`): a migration PR's gate says **HOLD** and a person merges it. That is expected, so state it in the PR body instead of trying to clear it (L26). Live-update behaviour is in [operations.md § Panel access and deploys](../operations.md#panel-access-and-deploys).

> This page outranks the `postgres-drizzle` skill wherever they differ. Where the skill says `drizzle-kit push` or `generate --custom` is fine, here it is not.

## Hard rules

1. **Never `drizzle-kit push`.** It changes a database without a migration file, so the schema, `drizzle/` and every other environment drift apart.
2. **Applied migrations are immutable.** Never edit, rename, reorder or delete a `drizzle/0*.sql`, a `drizzle/meta/*_snapshot.json` or the `_journal.json` entries (`.sstack/project.toml` `protected = ["drizzle/0*.sql"]`). A fix is a new `NNNN_*.sql`. Never hand-invent journal or snapshot entries.
3. **Never `generate --custom` for a rename (L47).** Its snapshot copies the previous one, so the next `generate` re-emits the whole schema. See the recipe below.
4. Change `db/schema.ts` first, then run `bun run db:generate` (`drizzle-kit generate`), then read the SQL it wrote before committing. Edit only the **new** file, and only to make it safer (for example a rename instead of drop and create).

## Rename recipe

`drizzle-kit` 0.31 has no flag to answer its "is this table created or renamed?" prompt. Run `drizzle-kit generate` under `/usr/bin/expect` with a dummy `DATABASE_URL_UNPOOLED`, and answer each prompt by matching its text: pick "rename" for the renamed table and "create" for genuinely new ones. `drizzle.config.ts` requires the variable, but `generate` does not connect, so any URL works. Read the SQL afterwards: it must `RENAME`, not `DROP` then `CREATE`. The `job_screenshots` to `job_media` migration (`drizzle/0045_job_media.sql`) is the precedent.

## Connections

- Any Postgres 16 or later. No Neon-specific code: migration and listener use the direct URL.
- `DATABASE_URL` is the pooled pool used by `db/client.ts` (max 5). `DATABASE_URL_UNPOOLED` is for `drizzle-kit` (`drizzle.config.ts`) and `LISTEN`, which a pooler cannot hold.
- `db/client.ts` reads `DATABASE_URL` at import, so `next build` fails at "Collecting page data" without it. In a checkout with no `.env.local`, set a dummy before `bun run build` (L7).
- Migrations run with `bun run db:migrate`: step 3 of `scripts/rollout.ts` on a pool Mac, and `vercel.json`'s build command, which runs `scripts/migrate-guard.ts` first. That guard (`lib/migrate-guard.ts`) holds a list of production Neon endpoints and refuses a non-production Vercel build aimed at one. It is inherited and held; do not extend it for Hive databases.

## Live-update tables

- A table that the panel or runner follows has the three `hive_notify_insert|update|delete` statement triggers from `drizzle/0040_live_notify.sql`, which `pg_notify('hive_changes', <table>)`.
- Adding such a table means: the triggers in its migration, its name in `TABLES` in `scripts/live-notify-regressions.ts`, and its name in the live-tables list in operations.md (L30). A table that must not wake the panel (`device_viewers`, `job_media`) is asserted to have none.

## Enums and shapes

- `run_stage` is a Postgres enum built from `STAGES` in `lib/events.ts`. Adding a value means `db/schema.ts` and `lib/events.ts` (STAGES) and `lib/stages.ts` (`STAGE_TRANSITIONS`) together, plus a migration (L23). Postgres cannot drop an enum value, so choose names carefully.
- Allow one migration plan per night when sequencing overnight runs; two collide on the journal (L23).
- Facts easy to get wrong: `runs` has no `ended_at` (use `status = "ended"` and `last_event_at`; L58). `sstack_defaults.sha` is the sha256 of the canonical files, not a commit id (L119).
- Writes that compare then write per repo take a Postgres advisory lock inside one transaction, with `pg_advisory_xact_lock`, as the Linear poll in `runner/ops.ts` and `runner/sstack-snapshot.ts` do (L51).

## Check before pushing

```sh
bun run db:generate                  # produces nothing if schema and migrations agree
TEST_DATABASE_URL=postgres://localhost:5432/postgres bun run test:regressions live-notify
```

The regression harness applies every migration to an empty database (`scripts/test-branch.ts`), so a migration that does not apply fails the whole suite.

## Why

Production data lives in these tables and the journal is the only record of what has run where. An immutable history and generated, reviewed SQL keep every machine's database reproducible from the repo alone.
