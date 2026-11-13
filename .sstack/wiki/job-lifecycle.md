---
summary: How a Linear issue becomes a job, moves through stages, and reaches a merge decision
paths: runner/intents.ts, runner/launch.ts, runner/ops.ts, lib/sources/linear.ts, lib/job-owner.ts, lib/factory.ts, lib/stages.ts, lib/events.ts, lib/ingest.ts, mcp/factory-report.ts, lib/merge-decision.ts, runner/merge-decision.ts, runner/merge-service.ts
updated: 3588135
---

# Job lifecycle

1. **Pickup.** `pickedUp()` takes an issue with the factory label, or assigned to Hive's Linear user
   or an opted-in email (`lib/sources/linear.ts:66-73`).
2. **Claim.** `claimDrafts` runs under one advisory lock and stops at `maxInFlight`
   (`runner/ops.ts:593`, `:601`). The owner is set on the first insert only, from the assignee, then
   the creator (`runner/ops.ts:623`, `lib/job-owner.ts:18-38`). A retry bumps `attempt`; the branch is
   `hive/<KEY>`, then `hive/<KEY>-a<n>` (`lib/factory.ts:34-35`).
3. **Launch.** `claimLaunch` is one compare-and-set on `t3_thread_id` + `machine_id`
   (`runner/ops.ts:909-952`); `startThread` runs `t3 start` from `origin/main` (`runner/launch.ts:73-75`).
4. **Stages.** `STAGE_TRANSITIONS` is keyed by cause, read from the event-id prefix: agents report
   working stages, `pr`, `waiting`, `failed`; the runner owns resume, merged, watchdog, stop and the
   rest (`lib/stages.ts:8-36`). Ingest refuses moves not in the table and stores the refusal
   (`lib/ingest.ts:417-421`).
5. **Merge.** `decideMerge` is pure (`lib/merge-decision.ts:166-264`); see
   [evidence-and-merge](evidence-and-merge.md). Only the runner merges, through `mergeNow`.

## Traps

- The owner never changes on reclaim, even if the assignee did.
- Events from an earlier attempt's branch are dropped (`lib/stages.ts:55`), so a stale thread can't
  move a retry.
- The claim lock is still named `'marshal-factory linear-poll'` because older runners take it too.
- The merge pass reads only its own machine's jobs (`runner/merge-decision.ts:196`).

Related: [live-updates](live-updates.md), [sandboxes-and-image](sandboxes-and-image.md). Map: [start-here](start-here.md).
