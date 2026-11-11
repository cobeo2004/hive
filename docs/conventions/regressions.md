# Regression scripts

Applies to `scripts/*-regressions.ts`, `scripts/fixtures/**` and `scripts/test-*.ts`. Hive has no test framework: each regression is a Bun script that asserts with `node:assert/strict` against a throwaway database. Behaviour and the harness are described in [operations.md § Testing](../operations.md#testing); this page is the rules for writing and running them.

## Run

```sh
bun install --frozen-lockfile        # first, in a fresh worktree: it has no node_modules
TEST_DATABASE_URL=postgres://localhost:5432/postgres bun run test:regressions [name-prefix]
```

- `scripts/test-branch.ts` creates `hive_test_<time>_<rand>` on that server, migrates it, runs each script against it, and drops it. The role needs CREATEDB. Run one script with its name prefix (`... ingest`).
- Run the **full** suite in the foreground with output redirected to a log file. A background run hides the failing script's name (L29).
- CI sets `REGRESSIONS_SKIP=playbook` (`.github/workflows/ci.yml`) until R13 rewrites `playbook-regressions.ts`. Locally, expect only that script to fail. A fresh worktree with no `.env.local` can also fail `proxy-regressions` (L6); neither failure is yours, but say so in the PR.

## Guard

- The first line of every script is `import "./test-guard";`. It refuses to run unless the harness started it, and refuses the database `.env.local` points at, including aliases (`127.0.0.1` for `localhost`, an explicit `:5432`).
- During a run `lib/test-mode.ts` (`forbidInTest`) makes the real Linear client, the GitHub App, `t3 thread start|show|send` and the ingest URL throw. Never route around it; use a fake. Code you add that reaches an outside service must call `forbidInTest` too, or a test will hit the real service.
- `bun scripts/_scratch.ts` is refused by the guard (L102). Mutation checks go through the harness, below.

## Fixtures and fakes

- Build rows with `scripts/fixtures.ts` helpers (`linearJob`, ...) rather than inline objects. Branches use the `hive/` prefix via `attemptBranch`; a board card needs a `runs` row (L45).
- Fakes: `threads` in `runner/threads.ts`, the fake pulls in `lib/github/pulls.ts`, `scripts/fake-modal.ts`. Add a Slack API call and you update all three fake Slacks: `slack-regressions`, `slack-actions-regressions`, `slack-source-regressions` (L5). Their default `{ok:true}` branch hides the new call.
- Slack lookups are cached per process, misses included (`slackIds` in `runner/slack.ts`). Give each case that needs a lookup its own new user (L48).
- Git fixtures use a real bare `origin` and have `commit()` push to it, not `update-ref` (L60). Pass `-c core.autocrlf=false` when the test checks exact file text (L53).
- Restore every stub in `try/finally`. A case added later must not see an earlier stub (L111).
- `lib/linear` cannot be imported statically in a script that is not on the ESLint allowlist (`eslint.config.mjs`). Prefer testing through `sourceFor`; the dynamic-import workaround is for tests only (L31).

## Auth in tests

- Stub `session.read` from `lib/auth/server.ts`. Do not call `currentUser()` or `headers()`: `headers()` throws outside a request in Bun (L10). `scripts/auth-flow-regressions.ts` is the model for driving Better Auth's real handler with a cookie jar.
- Compute TOTP codes from the base32 secret per RFC 6238. Set `two_factor.verified = true` before `verify-totp`, or a fresh secret is rejected (L32).
- Member fixtures need `setupDoneAt`, because `isMember` (`lib/auth/owner.ts`) requires TOTP **and** setup (L14).

## Assertions that actually fail

- Catch the thrown assertion, set `process.exitCode = 1`, and exit from `finally` with `process.exit(process.exitCode ?? 0)`, as `claim-regressions.ts` does. Break one assertion and confirm a non-zero exit (L52).
- **Mutation check.** Copy the script to `scripts/z<name>-regressions.ts`, break the behaviour or one assertion, run `bun run test:regressions z<name>`, then delete the copy. Use one copy per assertion: the first throw hides the rest (L120).
- Table-drive branchy cases (rate limits, trusted checks, lineage) so each row is a named failure.

## Renames and sweeps

When a literal changes (a prefix, a product name), search its escaped (`factory\/`), URL-encoded (`factory%2F`) and label-derived forms, and `scripts/fixtures/**`. Then run the full suite before review; a grep missed four scripts once (L3).

## Format

`bun run format` takes no file arguments (it is `biome format --write`; paths make it exit 1). Format named files with `bunx biome format --write <files>`. Then `bun run format:check` (L17, L69). Biome's line width is 160.

## Why

Every script writes to a database, and the factory's real database holds live jobs. The guard, the throwaway database and the forbidden-in-test list exist so a green run never costs anyone real work, and a mutation check is the only proof a new assertion can fail.
