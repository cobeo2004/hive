---
summary: Modal sandboxes, pinned base image, warm images, hibernate and wake, and when images rebuild
paths: lib/sandbox.ts, lib/modal-host.ts, lib/sandbox-image-build.ts, runner/sandbox.ts, runner/base-image.ts, runner/lifecycle.ts, scripts/sandbox-image.ts
updated: 3588135
---

# Sandboxes and images

- **Pins.** `pinnedVersions` covers T3, Claude Code, Codex, cursor-agent, Playwright MCP and the
  skills, plus a hash of `playbooks/{factory,onboarding}.md`, so a playbook edit is a new image
  version (`lib/sandbox.ts:71-108`).
- **Build.** Base layers install each pin; cursor-agent is checked with `sha256sum -c` against
  `CURSOR_AGENT_SHA256` (`lib/sandbox-image-build.ts:67-89`, `:264-282`). The image is saved only
  after versions match and the hooks run; a failed build keeps the old image.
- **Rebuild.** Each runner tick, `rebuildBaseImage` rebuilds when an image exists, has drifted from
  the pins and a Modal token is set; a failure for the same pins waits 60 minutes
  (`runner/base-image.ts:60-108`). Warm per-repo images: [repo-onboarding](repo-onboarding.md).
- **Lifecycle.** running → hibernated (in `pr`/`waiting`: snapshot, sandbox ended, slot freed) →
  woken → torn down on merged/failed (`runner/lifecycle.ts:42-58`).
- `createSandbox` gives up after 120 s and kills late arrivals: Modal's create can wait 21 minutes.

## Traps

- Snapshots don't carry env secrets. The wake path must pass the Claude token and Cursor key again
  (`runner/lifecycle.ts:459-470`).
- Bumping `cursorAgentVersion` without a sha256 entry makes the build throw.
- A runner with no image never builds its first one; run `scripts/sandbox-image.ts` by hand.
- `sandbox_id` and `sandbox_snapshot` both set means a crash mid hibernate or wake; it settles back
  to hibernated.

Related: [accounts-and-credentials](accounts-and-credentials.md), [job-lifecycle](job-lifecycle.md).
