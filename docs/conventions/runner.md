# Runner and host code

Applies to `runner/**`, `lib/toml-patch.ts`, `lib/t3-*.ts`, `lib/modal-*.ts`, `lib/sandbox*.ts`, `lib/host.ts` and `lib/exec.ts`. How each part behaves is in [operations.md](../operations.md) (§ Parts, Running jobs in Modal sandboxes, Rolling out a merge); this page is the rules for changing the code.

## Who runs where

- `runner/` is the only process that touches T3, git and the GitHub API. It runs under **Bun**. The panel runs under **Node**, so nothing the panel imports may use `Bun.*` or `bun:` modules.
- Bun-only today: `lib/toml-patch.ts` (`Bun.TOML`, declared locally because tsc has no bun-types), `lib/t3-state.ts` (`bun:sqlite`), `runner/sstack-defaults.ts`. Do not import them from `app/` or `components/`.
- Do not `structuredClone` the output of `Bun.TOML.parse`; use `JSON.parse(JSON.stringify(...))` (L94). `lib/workflow-chain.ts` and `workflow-edits.ts` parse TOML with `smol-toml` because the panel needs them.

## JobHost

Every file, git and T3 action for a job goes through `JobHost` (`lib/host.ts`: `run`, `readFile`, `writeFile`, `exists`, `list`, `remove`). `localHost` and the Modal host (`lib/modal-host.ts`) then behave the same, so a sandbox job and a Mac job share one code path. Never call `fs` or `child_process` for a job's files.

- `exec` (`lib/exec.ts`) and `localHost.run` **do not trim stdout**. When exact text matters (trailing newline, CRLF), call `host.run` and trim only `rev-parse` output (L49).
- Secrets go in `ExecOptions.env`, never argv: error messages quote argv.
- `exec` settles when the process exits. Parse output after awaiting it, never in a callback where a throw is lost.

## T3 CLI and the environment agents see

- `T3CODE_CLI_PATH` (set by the LaunchAgent) names the `t3` binary, else `t3` on PATH (`lib/host.ts`).
- **Env set on `t3 thread start` does not reach the agent.** `startThread` (`lib/t3-client.ts`, called from `runner/launch.ts`) runs the `t3` CLI through `host.run`; an `env` option there (`ExecOptions.env` in `lib/exec.ts`) would only affect that CLI process. The agent is spawned by the long-lived T3 server, which started earlier with its own environment. So `SSTACK_UNATTENDED`, `SSTACK_PLAN_GATE` or any other variable set that way never arrives (accepted lesson L174).
- To change how sstack behaves for one job, write **the job worktree's** `.sstack/local/config.toml`. `.sstack/local/` is git-ignored, so nothing leaks into the PR. Hive-wide defaults live in the runner's `~/.sstack/config.toml` (`runner/sstack-defaults.ts`).
- Sandboxes are different: Modal secrets and the sandbox's own env are real process environment (`runner/sandbox.ts`, `lib/modal-secrets.ts`) and never pass through the runner's logs. Anything the agent needs that is not a sstack setting goes in a Modal secret or the launch message (`runner/ops.ts` builds it).
- Before assuming any delivery channel, run it: start a thread that prints `env`.

## Queue and timers

- `serialQueue` (`runner/queue.ts`) runs one step at a time with a hard timeout (default 300 s). Keep steps short and idempotent.
- A network poll (Claude usage, device frames) runs on its own timer with `everyAtMost`'s in-flight guard and a `.catch`, as `runner/index.ts` does. Never put a poll on the shared queue: one slow response stalls every job (L77).
- A compare-then-write per repo goes in an advisory-lock transaction, with `pg_advisory_xact_lock`, as the Linear poll in `runner/ops.ts` does; a failed `git fetch` aborts without writing (L51).

## Boundaries

- Reach Linear only through `sourceFor(job.source)` (`lib/sources`). ESLint enforces it; never add an `eslint-disable` in non-test code. Add an adapter method instead (L35).
- Only `runner/merge-service.ts` calls `mergePull`. Everything else records an `approve_merge` intent.
- Code that calls T3, Linear, GitHub or ingest goes through guarded helpers so regressions throw (`lib/test-mode.ts`).
- Semgrep (`.github/workflows/semgrep.yml`) blocks `new RegExp(variable)` (use a static regex; L91) and AES-GCM without `authTagLength: 16` on both cipher and decipher (L40).

## Matching threads, transcripts and heartbeats

- Match a child's Claude transcript or Codex rollout by the brief text named in `<worktree>/<run_dir>/run.json` `.brief`, not by time (`runner/sstack-lineage.ts`; L98, L113). Search every `~/.claude/projects/*` folder (L103). A Codex rollout's first user item is an injected AGENTS.md: read the text before the first assistant reply (L109).
- A headless child matches no transcript: keep its stored tokens, show "—" (L99). Model `unknown` means no usable usage, so do not overwrite (L100).
- A new heartbeat field goes into `collectHeartbeat` (`runner/heartbeat.ts`), the schema in `lib/machine.ts` and the facts line in `components/panel/machines.tsx` together (L105).
- Re-patching `~/.sstack/config.toml` keeps the runner's local `[overnight]` table (`patch()` from `lib/toml-patch.ts`; L106). Resolve the root with `realpath`, refuse symlinks, and make rollback unable to throw (L118).

## Why

The runner is one process per Mac that owns every thread, branch and merge. A blocking step, a leaked secret or a second writer to the same checkout turns into a stuck job nobody is watching. `JobHost` and the queue are what keep a sandbox, a Mac and a test fake interchangeable.
