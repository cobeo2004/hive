---
summary: Adding a repository - the onboarding agent, the recipe, secrets, warm image builds, and known gaps
paths: runner/onboarding.ts, lib/repo-onboarding.ts, lib/onboarding.ts, lib/recipe.ts, playbooks/onboarding.md, app/actions/repositories.ts, app/(panel)/repositories/**, components/panel/repositories.tsx, components/panel/repo-onboarding.tsx, lib/repositories.ts, runner/sstack-snapshot.ts
updated: 3588135
---

# Repository onboarding

- **Add.** One transaction inserts `repo_settings` (state `analyzing`, Bugbot off with `bugbotWatch`)
  and an `onboard_repo` intent (`lib/repo-onboarding.ts:95-112`).
- **Agent.** Unless main already has a valid recipe, the runner runs an agent on
  `playbooks/onboarding.md` on `hive/onboarding`; it writes a result file the runner checks against
  `resultSchema` (`runner/onboarding.ts:73-101`, `:391-457`).
- **After the recipe.** Missing secrets → `needs_input` (names stored, values in the Modal secret
  `mf-repo-<owner>-<name>`); else `building` (`lib/onboarding.ts:96-120`).
- **Warm image.** Built from the base image, snapshotted, the old one deleted, then `snapshotSstack`
  (`runner/onboarding.ts:525-585`). A push touching the recipe, or a new base image, rebuilds it.
  Jobs launch from the warm image if it still fits the base (`lib/onboarding.ts:138-162`).
- **Panel.** The Repositories page reads only the DB (`lib/repositories.ts:99-112`); GitHub is called
  on demand for the add list and the Rebuild action.

## Known gaps (2026-11-14)

- `playbooks/onboarding.md:53` says branch `factory/onboarding`; the runner uses `hive/onboarding`.
- The trusted verify list is written only by the admin's Rebuild action
  (`app/actions/repositories.ts:103`), although `lib/onboarding.ts:75` says "at onboarding". Until
  Rebuild, project.toml evidence is `untrusted` ([evidence-and-merge](evidence-and-merge.md)). R18
  (m4-11) records it at onboarding.
- The runner trusts the recipe in the result JSON; it doesn't re-read the commit.
- `repo_settings` doesn't notify ([live-updates](live-updates.md)).

Related: [sandboxes-and-image](sandboxes-and-image.md).
