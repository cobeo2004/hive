---
summary: How regressions get a throwaway database, pick suites, and fake Modal, T3 and the sandbox runtime
paths: scripts/test-branch.ts, scripts/test-guard.ts, scripts/*-regressions.ts, scripts/fixtures.ts, scripts/fake-modal.ts, lib/test-mode.ts
updated: 3588135
---

# Testing

- `bun run test:regressions` → `scripts/test-branch.ts`. It needs `TEST_DATABASE_URL` with a role
  that can `CREATE DATABASE`, creates `hive_test_<minute>_<hex>`, migrates it, points
  `DATABASE_URL`/`_UNPOOLED` at it and drops it afterwards (`scripts/test-branch.ts:44-96`).
- Suites are filename prefixes: `bun scripts/test-branch.ts launch sandbox`. `REGRESSIONS_SKIP`
  leaves some out.
- `test-guard` refuses a suite not started by the harness, or one whose DB matches `.env.local`'s
  (`scripts/test-guard.ts:1-28`).
- Real Modal is blocked in test mode (`lib/test-mode.ts:62-66`).
- **Fakes:** `modal.api = fakeModal` (`scripts/fake-modal.ts`). `sandboxRuntime` is a mutable object
  tests overwrite (`runner/sandbox.ts:58-81`). A fake `JobHost` returns `{"threadId":"mcp:fake"}`
  (`scripts/launch-regressions.ts:280-301`). Rows come from `scripts/fixtures.ts`.

## Traps

- Running `bun scripts/x-regressions.ts` directly exits 1; always go through `test-branch.ts`.
- Overrides on `sandboxRuntime` and `hosts` are process-global; restore them in `finally`.
- CI skips `playbook` (`.github/workflows/ci.yml:71`). It fails because its expected frontmatter and
  `hooks/verify.ts` mention predate the sstack playbook (`scripts/playbook-regressions.ts:103-111`);
  R13 (m4-07) fixes it.

Related: [auth-and-access](auth-and-access.md) (cookie setup for screenshots),
[sandboxes-and-image](sandboxes-and-image.md).
