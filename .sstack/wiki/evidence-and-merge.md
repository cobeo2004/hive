---
summary: factory-verify, evidence states, trusted checks, the media rule and the off/trial/auto merge modes
paths: hooks/verify.ts, lib/evidence.ts, lib/recipe.ts, lib/trusted-checks.ts, lib/media.ts, lib/ingest.ts, lib/merge-decision.ts, runner/merge-decision.ts, runner/merge-service.ts, runner/verify.ts
updated: 3588135
---

# Evidence and merge

- **Which checks.** `factory-verify` runs `.sstack/project.toml` `verify`, else `.factory/setup.json`,
  else package.json scripts (`hooks/verify.ts:25-33`). A dirty tree or a moving HEAD makes the run
  unclean. It reports only on a factory branch.
- **Storage.** One evidence row per `(job_key, sha)`; a dirty run never replaces a clean one.
- **States.** `headEvidence`: no_checks, missing, stale, dirty, incomplete, untrusted, failed,
  verified (`lib/evidence.ts:230-273`). Trusted commands come from the DB
  (`repo_settings.onboarding_detail`), never from the PR.
- **Handover triggers.** Edits to `.factory/setup.json`, workflows, `.npmrc`, `bunfig.toml`, a nested
  package.json or any root script (`lib/trusted-checks.ts:52-78`). UI files without media, but only
  when the agent had a browser (Modal).
- **Modes.** `off`: hand over, no evaluation. `trial`: full evaluation, audited as "Would merge
  (trial)", never merges. `auto`: merges via `mergeNow`; if only verification is missing, the runner
  verifies the head itself. Owner approval skips agent/policy/Bugbot reasons, not checks or conflicts.

## Traps

- `.sstack/project.toml` isn't a trusted file; it is covered because its evidence must match the
  verify list recorded in the DB. With no recorded list, its evidence is always `untrusted` (see
  [repo-onboarding](repo-onboarding.md) for when the list is recorded).
- `lib/screenshots.ts` is a one-line re-export; media logic is `lib/media.ts`.
- Bugbot can turn itself on for a repo mid-pass after its first finished run.
- A refused merge isn't retried for the same head.

Related: [job-lifecycle](job-lifecycle.md).
