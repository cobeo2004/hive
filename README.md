# marshal-factory

A software factory that turns Linear issues into pull requests while you watch.

You label an issue in Linear, file one from the panel, or send one from Slack. A runner on your Mac picks it up within seconds and starts a [T3 Code](https://github.com/pingdotgg/t3code) thread for it on its own branch, `factory/<issue>`, either on the Mac itself or in its own [Modal](https://modal.com) sandbox in the cloud. The thread runs a harness (Claude Code, Codex, or another agent T3 offers, such as Cursor) with PStack, and works the issue on its own: triage, investigation, implementation, verification, and a pull request. Every stage, subagent, model and dollar spent streams live to a web panel, and Slack tells you when something needs you. When the agent needs a decision, it asks on the Linear issue and continues once you reply.

When the PR is ready, the agent reports whether it is confident it built what the issue asked for. In repos you switch to **Merge when confident**, the factory merges every PR the agent is confident about and that clears the hard limits (green checks, no conflicts, no open Bugbot findings, checks verified at the PR head), and reverts a merge that turns main red. Everything else is handed to you to review and merge from the panel, Slack or GitHub ([Merge decisions](docs/operations.md#merge-decisions)).

![The whole factory: sources, Postgres, your Mac, Modal and GitHub, with the numbered path one ticket takes](docs/images/factory-diagram.jpg)

The pieces:

- **Panel** (`app/`, `components/`): a Next.js app served by `bun run start` on a Mac of your own, optionally behind Tailscale. Its **Jobs** page shows every job as a board or a list (the header's Board/List switch; the panel remembers your pick), with each run's timeline and cost in a side panel you can expand to full view. **Inbox** lists what needs you: questions, PRs to review, failures. The panel files jobs and approves merges. Only the owner can sign in.
- **Ingest** (`app/api/ingest/`, `app/api/webhooks/[source]/`): panel routes that receive the reporter's events (`/api/ingest`, Bearer `FACTORY_INGEST_SECRET`) and the Linear and GitHub webhooks (`/api/webhooks/linear`, `/api/webhooks/github`, signature-checked), and write them to Postgres. They and `/api/slack/*` are the only paths that need no session.
- **Live updates**: Postgres triggers `NOTIFY hive_changes` with the changed table's name. The panel's `/api/live` streams those names to the open page, which re-renders; the runner listens too, so a new intent wakes it before its next tick.
- **Runner** (`runner/`): a Bun daemon on your Mac, run by launchd. It is the only part that touches T3, git and the GitHub API, starts and hibernates the Modal sandboxes, makes every merge, and posts the Slack notifications.
- **Slack app** (`app/api/slack/`, optional): notifications, buttons to answer, merge or request changes, and `/factory` to file jobs. The routes run in the panel and act through the same inbox actions as the panel.
- **Reporter** (`hooks/`, `mcp/`): Claude Code hooks and a small MCP server, installed into each target repo. They send the run's progress to the panel's `/api/ingest`.
- **Playbook** (`playbooks/factory.md`): the instructions every factory thread follows. It extends PStack's bug-fix and feature playbooks.

## What you need

Accounts:

- **Linear**, with a team for factory work and a personal API key.
- **GitHub**, for the target repo and a GitHub App the setup creates for you.
- **Postgres 16 or later**, on the panel's machine or hosted: the panel, its sign-in tables and its live updates all live there.
- Optional: **Modal**, to run jobs in cloud sandboxes ([Running jobs in Modal sandboxes](#running-jobs-in-modal-sandboxes)), and **Slack**, for notifications and acting from Slack ([Connecting Slack](#connecting-slack)).

On the Mac that runs the factory:

- macOS. The runner installs as a launchd agent and identifies the Mac by its hardware UUID.
- [Bun](https://bun.sh), git, and the [GitHub CLI](https://cli.github.com) signed in (`gh auth login`). Threads push branches and open PRs with your own git and `gh` credentials.
- Claude Code with the PStack plugin installed.
- T3 Code, running, with its `t3` command line tool. The installer looks for it at `~/.t3/bin/t3`, then on your `PATH`, or you can set `T3CODE_CLI_PATH`.
- `jq` and `openssl`, used by a few commands below.

## Install

These steps set up one factory: one Postgres database, one panel, and one Mac running the runner. Do them in order. Several steps depend on values an earlier step creates.

### 1. Clone the factory

```sh
git clone https://github.com/<you>/marshal-factory.git ~/code/marshal-factory
cd ~/code/marshal-factory
bun install
```

This checkout is the **live checkout**. The panel, the runner, and the hooks installed into your target repos all run code straight from this path. Keep it on `main` and don't move it. Do development work in a separate clone or worktree.

### 2. Change the value tied to the original setup

- `scripts/setup-github-app.ts`: change the manifest's `name` (`marshal-factory-ski043`) and `url`. GitHub App names are unique across GitHub, so you need your own, such as `marshal-factory-<you>`.

`vercel.json`, `scripts/migrate-guard.ts` and the rest of the files inherited from marshal-factory stay in the repo but are unused: Hive is self-hosted.

### 3. Prepare Linear

In the Linear team you want the factory to work in:

- Note the team key, the prefix of its issue ids. The defaults assume `FAC`.
- Make sure the team has the workflow states **Todo**, **In Progress**, **In Review** and **Done**. The factory moves issues between them by name.
- Create a label named `factory`. Only issues with this label in an unstarted state (such as Todo) are picked up.
- Create a personal API key under Settings → Security & access.

If your team key or label differs, set them in every place listed under [Settings](#settings).

### 4. Create the Postgres database

Hive needs Postgres 16 or later and does not care where it runs: the panel's Mac, a server on your tailnet, or a hosted one. Create a database, then write `.env.local` with the connection strings and the secrets you choose yourself. `FACTORY_PANEL_URL` is where step 8 serves the panel; ingest and the webhooks live under it:

```sh
cat > .env.local <<EOF
DATABASE_URL=postgres://postgres@127.0.0.1:5432/hive
DATABASE_URL_UNPOOLED=postgres://postgres@127.0.0.1:5432/hive
FACTORY_INGEST_SECRET=$(openssl rand -hex 32)
LINEAR_WEBHOOK_SECRET=$(openssl rand -hex 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
LINEAR_API_KEY=<your Linear API key>
FACTORY_TEAM_KEY=FAC
FACTORY_LABEL=factory
FACTORY_PANEL_URL=http://localhost:3000
EOF
chmod 600 .env.local
```

Create the tables, which also add the live-update triggers and the sign-in tables:

```sh
bun run db:migrate
```

`DATABASE_URL_UNPOOLED` may be the same connection string as `DATABASE_URL`; live updates LISTEN over it, so it must be a direct connection rather than a pooler. `PANEL_PORT` sets the port `next start` listens on, 3000 unless you set it.

### 5. Write the runner's config

The runner and the reporter read `~/.config/marshal-factory/config.json`:

```sh
mkdir -p ~/.config/marshal-factory
set -a; source .env.local; set +a
jq -n --arg key "$LINEAR_API_KEY" --arg url "$FACTORY_PANEL_URL/api/ingest" --arg secret "$FACTORY_INGEST_SECRET" \
  '{linearApiKey: $key, ingestUrl: $url, secret: $secret, factory: {teamKey: "FAC", label: "factory"}}' \
  > ~/.config/marshal-factory/config.json
chmod 600 ~/.config/marshal-factory/config.json
```

`ingestUrl` is the panel's `/api/ingest`; the runner copies it into each sandbox. `secret` must equal `FACTORY_INGEST_SECRET`, or ingest rejects the reporter's events. [Settings](#settings) lists the optional limits you can add under `factory`.

### 6. Create the GitHub App

The runner reads and merges PRs as a GitHub App, not as your `gh` login:

```sh
bun scripts/setup-github-app.ts
```

A browser page opens and sends the app manifest to GitHub. Click **Create GitHub App**, pick the repos the factory may work in, and click **Install**. The script saves the app's id, private key and webhook secret to `~/.config/marshal-factory/github-app.json` (mode 600). You can add repos to the installation later in GitHub's app settings. The app's webhook points at `$FACTORY_PANEL_URL/api/webhooks/github`; step 8 gives the panel its secret.

### 7. Create the Linear webhook

```sh
bun scripts/install-webhooks.ts
```

This registers a webhook on your team (Issue and Comment events) that points at `$FACTORY_PANEL_URL/api/webhooks/linear`, and records its id in the config. Running it again reuses the webhook at that URL; when it finds one at an older URL, such as the retired ingest Function, it says so, and you delete that one in Linear → Settings → API.

### 8. Install and start the panel

The panel is a normal Next.js server on this Mac, run by launchd. Build it, then install the LaunchAgent:

```sh
bun run build
PANEL_PORT=3000 bun scripts/install-panel.ts
tail -f ~/Library/Logs/marshal-factory/panel.log
```

`scripts/install-panel.ts` writes the LaunchAgent `com.hive.panel`, which runs `bun run start -- -p ${PANEL_PORT:-3000}` in this checkout: it starts at login, restarts if it exits, and reads `.env.local` itself. Re-running it with nothing changed leaves the agent alone; `bun scripts/install-panel.ts --uninstall` unloads it. Open the panel at `$FACTORY_PANEL_URL`, locally `http://localhost:3000`.

The panel is the only web server you need, and it takes its settings from `.env.local`: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `BETTER_AUTH_SECRET`, `FACTORY_PANEL_URL`, `FACTORY_INGEST_SECRET`, `LINEAR_WEBHOOK_SECRET` and `GITHUB_APP_WEBHOOK_SECRET` (`jq -r .webhook_secret ~/.config/marshal-factory/github-app.json`), `LINEAR_API_KEY` for the New job form, `GITHUB_APP_ID` and `GITHUB_APP_PRIVATE_KEY` from `~/.config/marshal-factory/github-app.json` so **Add repository** can list the repos the App reaches, `FACTORY_TEAM_KEY` and `FACTORY_LABEL` when they differ from `FAC` and `factory`, and optionally `MODAL_TOKEN_ID` and `MODAL_TOKEN_SECRET` so you can paste a repo's secrets in the panel instead of running a command on the Mac, and `SLACK_BOT_TOKEN`, `SLACK_SIGNING_SECRET` and `SLACK_OWNER_USER_ID` ([Connecting Slack](#connecting-slack)). Restart the panel after changing them (`bun scripts/install-panel.ts --uninstall && PANEL_PORT=3000 bun scripts/install-panel.ts`).

**Tailscale is optional.** Any reverse proxy works, and nothing in the app reads a proxy's headers. To keep the panel on your tailnet only, run `tailscale serve --bg http://localhost:3000` on this Mac and set `FACTORY_PANEL_URL` to the `https://<mac>.<tailnet>.ts.net` URL it prints. Linear, GitHub and Slack cannot reach a tailnet-only panel. Funnel makes a whole port public, so give exactly the three public prefixes their own port, with targets that keep the prefix:

```sh
tailscale funnel --bg --https=8443 --set-path /api/ingest http://localhost:3000/api/ingest
tailscale funnel --bg --https=8443 --set-path /api/webhooks http://localhost:3000/api/webhooks
tailscale funnel --bg --https=8443 --set-path /api/slack http://localhost:3000/api/slack
```

Set `FACTORY_PUBLIC_URL=https://<mac>.<tailnet>.ts.net:8443` in `.env.local`: `setup-github-app` and `install-webhooks` register their webhooks there. Use the same base for `ingestUrl` in `~/.config/marshal-factory/config.json` and for the URLs in the Slack manifest. `tailscale funnel status` should list only those three paths on :8443, and `tailscale serve status` the whole panel on :443 for the tailnet.

Everything else, including `/auth/*` and `/api/live`, stays on the tailnet. Without Tailscale the panel is public, and its own sign-in is the gate ([Panel access and deploys](docs/operations.md#panel-access-and-deploys)).

Then create the first admin. On the Mac, with `.env.local` in place, `bun scripts/setup-token.ts` prints a one-time setup link, valid for an hour. Open it, set your name, email and password, then turn on two-factor authentication on `/setup`. The [panel access steps](docs/operations.md#panel-access-and-deploys) cover invites and password resets.

### 9. Start the runner

```sh
bun scripts/install-runner.ts
tail -f ~/Library/Logs/marshal-factory/runner.log
```

This installs the LaunchAgent `com.marshal-factory.runner`. It starts at login and restarts if it exits. Within a minute the log shows `listen` `live` and a `heartbeat`, and your Mac appears under **Machines** in the panel. The runner still needs a repo to work in, which the next section adds.

## Add your repo

A target repo is any git repo whose `origin` is on GitHub and whose default branch is `main`. The GitHub App must be installed on it.

```sh
bun scripts/install-target.ts ~/code/my-app
```

This writes three things into the repo, all pointing at your live checkout:

- `.claude/settings.json`: the reporter hooks.
- `.mcp.json`: the `factory-report` MCP server.
- `.agents/playbooks/factory.md`: a copy of the factory playbook. Threads follow the factory's own `playbooks/factory.md`, which every launch message names; the copy may only add notes about the repo.

It merges with any settings the repo already has, adds `.claude/**` to the ESLint ignores when it can, and adds the repo to `factory.repos` in your config. Running it again changes nothing.

Commit those files and push them to `main`. Every thread starts from a fresh worktree of `origin/main`, so a thread can only see the hooks once they're on `main`.

Then restart the runner so it loads the new repo: `bun scripts/install-runner.ts --uninstall && bun scripts/install-runner.ts`. At startup the runner adds each checkout in `factory.repos` to the panel's **Repositories** page, and the first one becomes the default repo when there is none yet.

## Repositories

The factory can work in several repos. **Repositories** in the panel lists each one with its open jobs, its last job, where its jobs can run (Modal, a runner's local checkout, or neither yet) and how far the factory may merge there. Open a repo to change its display name, make it the default, disable it, give it a default harness and place, or set merging and **Require Bugbot review**.

An issue picks its repo with a child of the **Repository** label group in Linear, named by the repo's display name (`factory-demo` for `ski043/factory-demo` unless you rename it). An issue without one goes to the default repo. A label that names an unknown or disabled repo also goes to the default, and the issue gets one comment saying so. **New job** has a Repository select and always files the issue with its Repository label.

Per repo, a default harness and place apply when the ticket has no Harness or Runs on label: the ticket's label beats the repo default, which beats Settings. A local run needs the runner's checkout of the repo; without one the job runs in a Modal sandbox when Modal is ready, and otherwise stays queued.

To add a repo, click **Add repository** on the Repositories page and pick one of the repos the GitHub App can reach. **Grant access to more repositories** opens the App's installation settings when the one you want is missing. The factory then onboards it without you:

1. If the repo's `main` has a `.factory/setup.json`, the factory uses it. Otherwise an agent reads the repo in a Modal sandbox, writes that setup recipe, runs the setup and every check until they pass, and opens a pull request titled **Add the factory setup recipe**. Merge it when it looks right.
2. If the recipe names secrets the checks need, the repo shows **Needs input** with each name and what it is for. Paste the values in the repo's detail pane, or, when the panel has no Modal token, run the command it shows on the runner Mac (`bun scripts/repo-secret.ts owner/name NAME`), which asks for the value without echoing it. Values go straight to a Modal secret for that repo and are never stored by the factory.
3. The factory builds a warm sandbox image with the repo cloned and set up, and the repo turns **Ready**. Its Modal jobs start from that image, and a push to `main` that changes the recipe or a lockfile rebuilds it in the background.

The new repo also gets its child in the **Repository** label group. A repo you also want to run locally still needs `bun scripts/install-target.ts` on the runner Mac ([Add your repo](#add-your-repo)). [docs/operations.md](docs/operations.md#onboarding-a-repository) has the details.

The Jobs page and the Inbox have a repository filter in the header. It is kept in `?repo=owner/name` and remembered for the next visit. Cards and rows show their repo once more than one repo has jobs.

## Use it

**Start a job.** Either:

- In Linear, add the `factory` label to an issue in Todo.
- In the panel, click **New job**, then write a title, a description, and optionally paste or drop images. The panel files the issue in Linear for you.
- In Slack, type `/factory <what to build>`, or pick **Send to factory** from a message's ⋯ menu. Both open the same form ([Connecting Slack](#connecting-slack)).

To run one issue on another harness or place than Settings, add a child of the **Harness** or **Runs on** label group, and to send it to another repo than the default, a child of **Repository**; `bun scripts/sync-linear-labels.ts` creates the groups ([Per-ticket overrides](docs/operations.md#per-ticket-overrides), [Repositories](#repositories)).

Within seconds the issue moves to In Progress, a comment says the factory took it, and a card appears on the board. Write the issue the way you would for a colleague who can't ask questions: what's wrong or what you want, and how you'll know it's done. Images on the issue are downloaded and given to the thread.

**Watch it.** Cards move through Queued, Triage, Investigating, Implementing, Verifying and PR. Open a card to see the stage history, the agents and subagents, the models, and the spend; the expand button next to its close button (or `?full=1` in the link) opens it in full view, and Esc goes back. **Other activity** lists Claude Code sessions that report no factory stage, such as work you start by hand in a target repo. **Machines** shows each runner's Mac, its load, and its T3 projects.

![The panel's board: runs grouped by stage, each card showing its ticket, model, spend, and machine](docs/images/panel-board.png)

**What needs you.** The panel's **Inbox** collects everything waiting on you: questions, PRs handed over for review, failures, failed reverts and stops that couldn't be confirmed, each with its actions. With Slack connected, each one also arrives as a message with the same buttons, which is edited once the item is resolved.

**Answer questions.** When the issue is ambiguous or something blocks the run, the card moves to Waiting, and the question is posted as a comment on the Linear issue, usually with options to pick from. Reply on the issue, in the Inbox, or with **Answer** in Slack. The thread continues with your answer.

**Review and merge.** At the PR stage, the issue moves to In Review with a link to the pull request, and the agent reports whether it is confident in what it built. In a repo set to **Merge when confident**, a confident PR that clears the hard limits is merged by the factory. Otherwise it lands in the Inbox: review it as you would any PR, then merge from the panel (**Merge**, or **Approve and merge** in the Inbox), with **Approve and merge** in Slack, or on GitHub, or send it back with **Request changes**. Every merge the factory makes, including your approvals, is done by the runner. Either way, the issue moves to Done and the worktree or sandbox is cleaned up. If main moves on and the PR conflicts, the factory tells the thread to merge main and fix it.

**Stop a job.** Remove the `factory` label, or cancel the issue. The runner stops the thread.

**When it fails.** A job fails when the agent gives up, or when it stays stuck after one nudge. The reason is posted on the issue, the issue goes back to Todo, and the label changes to `factory-failed`. To retry, press **Retry** on the job's item in the panel's Needs you inbox or in its Slack message, with an optional note for the next attempt, or add `factory` to the issue again. The retry runs on a new branch (`factory/FAC-7-a2`). A failed job's worktree is kept for three days, so you can look at what it did. Spend is measured per attempt and shown on the card; no amount stops a run.

## Settings

The panel's **Settings** page holds what you change day to day: the default harness and model for new jobs, where jobs run (**Run jobs on**: this Mac or Modal, with what's still missing for Modal), and Slack notifications. Per repo, **Repositories** sets merging (**Off**, **Trial** or **Merge when confident**) and **Require Bugbot review**. A ticket's **Harness**, **Runs on** and **Repository** labels beat the repo's defaults, which beat Settings.

The optional `factory` object in `~/.config/marshal-factory/config.json` overrides these defaults (from `lib/config.ts`):

- `teamKey` (`FAC`) and `label` (`factory`): the Linear team and label to work on.
- `maxInFlight` (4): how many jobs this Mac runs at once.
- `provider` (`claudeAgent`) and `model` (`claude-opus-5-5`): what new threads run on.
- `stuckAfterMinutes` (30) and `failAfterNudgeMinutes` (30): when a quiet job gets nudged, and when it fails after the nudge.
- `cleanupGraceDays` (3): how long a failed job's worktree is kept.

[docs/operations.md](docs/operations.md) lists the rest.

If you change the team key or label, also change them (`FACTORY_TEAM_KEY` and `FACTORY_LABEL`) in the panel's `.env.local`. Then rerun `bun scripts/install-webhooks.ts` for a new team.

## Running jobs in Modal sandboxes

Instead of this Mac's T3, the runner can start each job in its own Modal sandbox, so jobs don't share a machine and more of them run at once. On the runner Mac:

```sh
uv tool install modal && modal token new
bun scripts/sandbox-image.ts
mkdir -p ~/.codex-factory-1 && CODEX_HOME=~/.codex-factory-1 codex login --device-auth
```

For Claude Code jobs, run `claude setup-token`, add the token as `CLAUDE_CODE_OAUTH_TOKEN=...` to `.env.local` in the live checkout and restart the runner. Without it, those jobs run on Codex. A Claude Code job needs no Codex login, so with the token any number of them run side by side, up to `factory.sandbox.maxParallel` (4) and `factory.maxInFlight` (4). Each Codex job holds one Codex login while its sandbox runs: each extra login (`~/.codex-factory-2` and so on) lets one more Codex sandbox run; list them in `factory.sandbox.codexSlots`.

Then set **Run jobs on** to Modal in the panel's Settings, which shows anything still missing. A job waiting for review or an answer hibernates to a snapshot after five minutes and wakes when it is needed, so it does not pay for a running sandbox while it waits. Claude Code and Codex jobs show stages and cost; other harnesses show neither. The runner rebuilds the image itself when a pin or a playbook changes; rebuild it by hand (`bun scripts/sandbox-image.ts`) when you change the hooks or the MCP server. [docs/operations.md](docs/operations.md#running-jobs-in-modal-sandboxes) has the details, including opening a sandboxed job in T3.

## Connecting Slack

Optional. With Slack connected, the runner messages you when a job needs you or the factory merges or reverts on its own, and edits the message once it's resolved. The messages carry the Inbox's buttons (**Approve and merge**, **Request changes**, **Answer**, **Close**, **Dismiss**), and `/factory` or the **Send to factory** message shortcut files new jobs. Only your own Slack account can act.

1. Create the app at [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → **From a manifest**, with the manifest in [docs/operations.md](docs/operations.md#slack-notifications), then install it to your workspace. Change the panel URL in it to yours.
2. Add three values to `.env.local` in the live checkout: `SLACK_BOT_TOKEN` (**OAuth & Permissions** → Bot User OAuth Token), `SLACK_SIGNING_SECRET` (**Basic Information** → App Credentials) and `SLACK_OWNER_USER_ID` (your Slack profile → ⋯ → **Copy member ID**).
3. Add the same three to the panel's `.env.local`, restart the panel (`bun scripts/install-panel.ts --uninstall && bun scripts/install-panel.ts`), and restart the runner (`bun scripts/install-runner.ts --uninstall && bun scripts/install-runner.ts`).
4. In the panel's **Settings** → **Notifications**, pick your DMs or a channel, the events you want and optional quiet hours, then **Send test message**.

[docs/operations.md](docs/operations.md#slack-notifications) has the details.

## Updating

After a merge to `main`, update the live checkout with:

```sh
bun scripts/rollout.ts
```

It stops the runner, pulls, migrates, builds the panel and restarts it until `/auth/sign-in` answers 200, rebuilds the sandbox image when it changed, and starts the runner again. [docs/operations.md](docs/operations.md#rolling-out-a-merge) has the steps and the opt-in canary.

## Troubleshooting

- **Start with the runner log**: `~/Library/Logs/marshal-factory/runner.log`. Each line is one JSON event. Errors name the step that failed.
- **An issue isn't picked up.** Check that it is in your team (`teamKey`), has the label, and is in an unstarted state such as Todo. Also check that **Repositories** lists at least one repo or `factory.repos` isn't empty, and that the Linear webhook exists under Linear → Settings → API. The runner also polls every 90 seconds, so a missed webhook only delays the job.
- **Machine shows offline.** The runner isn't sending heartbeats. Check `launchctl list | grep marshal-factory`, then the log. Run `bun runner/index.ts --once` in the live checkout to do one pass by hand and see its output.
- **Sign-in fails with "Invalid origin."** Better Auth trusts only `FACTORY_PANEL_URL`. Set it to the URL you open the panel at, and restart the panel. See [panel access](docs/operations.md#panel-access-and-deploys).
- **The board has no live updates.** The footer says Connecting while `/api/live` is down. Check that the migrations ran (they add the `hive_notify` triggers) and that `DATABASE_URL_UNPOOLED` in the panel's `.env.local` is a direct connection: a LISTEN needs one, not a pooler.
- **A run has no stages or costs.** The target repo's hooks aren't reaching ingest. Check that the files from `install-target` are on the repo's `main`, and that `secret` in your config equals `FACTORY_INGEST_SECRET` in the panel's `.env.local`.
- **You moved the live checkout.** The hooks and the LaunchAgent hold its old path. Run `install-target` for each repo and `install-runner` again.
- **Repositories shows a repo as failed with "The image build was still running after 45 minutes, so the factory stopped it."** The runner never saw the warm-image build finish, for example because a rollout restarted it while the build ran. Until a new image lands, that repo's jobs run without a warm image (the runner logs `sandbox:warm-image-outdated`), so they clone and install from scratch. Press **Rebuild image** on the repo's Repositories entry; the image builds in a few minutes and the repo returns to Ready. See Freshness in [Onboarding a repository](docs/operations.md#onboarding-a-repository).

## Developing

Work in a separate clone or worktree, never in the live checkout. Run `bun dev` for the panel against a database of your own, not production.

`TEST_DATABASE_URL=postgres://localhost/postgres bun run test:regressions` runs every `scripts/*-regressions.ts` against a throwaway `hive_test_*` database it creates on that server, migrates, and drops when the run ends. The role needs the CREATEDB privilege. Pass a prefix to run a subset, for example `bun run test:regressions ingest`. During a test run, the real Linear client, the GitHub App and `t3` commands refuse to run, so a test can't touch real work.

## Further reading

- [docs/operations.md](docs/operations.md): how each part behaves, including the runner, write-back, retries, spend, cleanup, the watchdog, sign-in and deploys.
- [playbooks/factory.md](playbooks/factory.md): what each factory thread is told to do.
- [docs/research/](docs/research/): background reports from the initial investigation.
