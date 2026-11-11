# Shared `lib/`

Applies to `lib/**`, except the Bun-only and host files covered by [runner.md](runner.md) and the auth files covered by [auth.md](auth.md). `lib/` is imported by both the Node panel and the Bun runner, so it is where a boundary slips first.

## Runtime

- A module the panel imports must run under Node and Next: no `Bun.*`, no `bun:` modules. Bun-only files are listed in runner.md; keep new ones out of anything `app/` or `components/` reaches.
- Prefer a plain function over a class or a registry. Most `lib/` files are one noun with a few exported functions (`lib/evidence.ts`, `lib/stages.ts`); match that.
- Read environment in a function, not at import, when a test or a build may not have it. `db/client.ts` is the cautionary case (see [db.md](db.md)).

## Import boundaries (ESLint, `eslint.config.mjs`)

- Linear only through `sourceFor(job.source)` in `lib/sources`. Do not import `lib/linear.ts` or a source adapter directly, and never call `sourceFor("linear")` with a literal outside `lib/sources`. `scripts/lint-boundary-regressions.ts` pins the rules.
- `mergePull` only inside `runner/merge-service.ts`. Elsewhere record an `approve_merge` intent.
- Do not silence a boundary with `eslint-disable` in non-test code. Add a method to the adapter or a function in the owner module (L35).

## Gates your diff must pass

These are CI jobs (`.github/workflows/`), and `.sstack/project.toml` `verify` runs the first three:

- `bun run lint` (ESLint with the boundary rules).
- `bunx next typegen && bunx tsc --noEmit`.
- `bun run format:check`: Biome, 160 columns, double quotes, trailing commas, semicolons. Run `bun run format` first (no file arguments), then the check (L17, L69). Biome's linter is off; do not add lint rules through it.
- Semgrep (`p/default`, `p/typescript`): no `new RegExp(variable)` even for a validated key, use a static regex (L91); AES-GCM needs `authTagLength: 16` on cipher and decipher and a 16-byte tag check (`lib/creds.ts`; L40). Run Semgrep on changed files before pushing.
- The regression job; see [regressions.md](regressions.md).

## Dependencies and held files

`package.json`, `bun.lock`, `vercel.json` and `.github/**` are held for the owner. A feature plan adds no dependency. If the work seems to need one, stop and ask; there is usually a Node built-in (`node:crypto`, `node:util`) or an installed package that covers it. `scripts/contrast-regressions.ts` documents the one place a transitive install is used and why.

## Client components

A `"use client"` file may import types from `lib/` but not values from a module that pulls in `node:crypto`, the database or Bun. `lib/creds.ts`, `lib/pool-accounts.ts` and `lib/toml-patch.ts` are such modules (L141, L152, L178). Inline the small rule, move it to a pure module, or pass the function in as a parameter, as `lib/workflow-edits.ts` takes the patcher. A `"use server"` file in `app/actions/` exports only async functions; types, constants and helpers live in `lib/` (L172).

## Exhaustive types

- A new `InboxKind` updates every `Record<InboxKind, ...>` in `lib/inbox.ts` and its siblings (L67).
- A plan-approval `kind` in the stage report goes in the separate `reportToolShape`, not `stageReportShape` (L66).
- New enum-like values touch the database enum, `lib/events.ts` and `lib/stages.ts` together; see [db.md](db.md).

## Detect state from structure, not text

Do not infer provider state by matching words in messages.
- Rate limits: `transcriptRateLimited` in `lib/transcript.ts` (last user or assistant entry is an assistant entry with `error: "rate_limit"`, sidechains and tool-result-only user entries skipped) and `parseRollout` in `lib/codex-usage.ts` (`usage_limit_exceeded`). Three rounds of narrowing a text match in `lib/creds.ts` still left a finding (L88, L96, L101).
- Package scripts in `lib/trusted-checks.ts`: any command it cannot read as a plain script name is **handed over** to a person. No tokenizer, brace expansion, `pre`/`post` lifecycle guessing, `npm:` prefixes or duplicate `scripts` keys (L97, L104, L112).

## Diff size

The factory caps a PR at `max_diff_lines` 400. Measure against the merge base, not the moving tip: `git diff --numstat $(git merge-base origin/main HEAD)` (L108, L110). Docs-only diffs may exceed it; say so in the PR body.

## Why

`lib/` is shared by processes with different runtimes and different blast radius. Boundaries enforced by lint, structural detection and "hand over when unsure" keep a clever shortcut here from becoming a merge the factory should not have made.
