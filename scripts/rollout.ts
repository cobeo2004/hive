import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { loadLimits } from "../lib/config";
import { readRollout, ROLLOUT_PATH, startupVerdict, touchedInputs, waitForPanel } from "../lib/rollout";
import { imageProblem, IMAGE_BUNDLES, readSandboxImage } from "../lib/sandbox";

// Rolls merged main out to the live setup, in the order the parts depend on each other, and stops
// at the first failure:
//   1. refuse while this machine's runner has jobs in flight (--wait waits for them instead)
//   2. stop the runner, pull main and bun install in the checkout
//   3. bun run db:migrate
//   4. bun run build, then restart the panel and wait for it to answer 200
//   5. rebuild the sandbox image when its pins drifted or its bundles' inputs changed since it was built
//   6. reinstall the runner and wait for its first clean tick
// Then it records the commit in ~/.config/marshal-factory/rollout.json for the next run.
//   bun scripts/rollout.ts [--wait] [--canary] [--force] [--checkout <path>]
// --canary runs scripts/canary.ts afterwards. --force rolls out even when the commit was rolled out
// already. --checkout names the live checkout when this script runs from another one.
// Steps 4 to 6 run in a fresh process from the pulled checkout's script, so they are the new code's.

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};
const checkout = resolve(option("--checkout") ?? join(import.meta.dirname, ".."));
const LOG_PATH = join(homedir(), "Library/Logs/marshal-factory/runner.log");
const ALREADY_STOPPED = "--runner-stopped";

const t0 = Date.now();
const log = (message: string) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s] ${message}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class StepError extends Error {}
let runnerStopped = flag(ALREADY_STOPPED);

/** Runs a command in the checkout with its output shown, failing the rollout when it fails. */
function run(command: string, commandArgs: string[]) {
  log(`$ ${[command, ...commandArgs].join(" ")}`);
  const result = spawnSync(command, commandArgs, { cwd: checkout, stdio: "inherit" });
  if (result.status !== 0) throw new StepError(`${command} ${commandArgs.join(" ")} exited ${result.status ?? result.signal}`);
}
const read = (command: string, commandArgs: string[]) => execFileSync(command, commandArgs, { cwd: checkout, encoding: "utf8" }).trim();
const git = (...gitArgs: string[]) => read("git", gitArgs);

async function waitFor<T>(what: string, timeoutMs: number, everyMs: number, check: () => Promise<T | undefined> | T | undefined) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new StepError(`gave up waiting for ${what} after ${Math.round(timeoutMs / 60_000)} minutes`);
    await sleep(everyMs);
  }
}

/** This machine's jobs whose thread is working or stopping, counted as the runner counts them. */
async function inFlight() {
  const { machineInFlight } = await import(join(checkout, "runner/ops.ts"));
  const { thisMachine } = await import(join(checkout, "runner/heartbeat.ts"));
  return (await machineInFlight((await thisMachine()).id)) as number;
}

async function beforePull() {
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== "main") throw new StepError(`${checkout} is on ${branch}; the live checkout must be on main`);
  if (git("status", "--porcelain", "--untracked-files=no") !== "") throw new StepError(`${checkout} has uncommitted changes`);
  git("fetch", "-q", "origin", "main");
  const target = git("rev-parse", "origin/main");
  const last = readRollout();
  if (last?.commit === target && git("rev-parse", "HEAD") === target && !flag("--force")) {
    log(`${target.slice(0, 7)} is rolled out already (${last.at}); --force rolls it out again`);
    return false;
  }
  log(`rolling out ${target.slice(0, 7)} to ${checkout}; last rollout ${last ? `${last.commit.slice(0, 7)} at ${last.at}` : "none recorded"}`);

  process.chdir(checkout);
  process.loadEnvFile(".env.local");
  let busy = await inFlight();
  if (busy > 0 && !flag("--wait")) throw new StepError(`${busy} job(s) in flight on this machine; rerun with --wait to wait for them`);
  if (busy > 0) {
    log(`${busy} job(s) in flight; waiting until none is`);
    await waitFor("jobs in flight to finish", 6 * 3_600_000, 60_000, async () => ((busy = await inFlight()) === 0 ? true : undefined));
  }
  run("bun", ["scripts/install-runner.ts", "--uninstall"]);
  runnerStopped = true;
  // The runner may have claimed a job between the count and the stop.
  busy = await inFlight();
  if (busy > 0) {
    run("bun", ["scripts/install-runner.ts"]);
    runnerStopped = false;
    throw new StepError(`a job was claimed while stopping the runner; it runs again, rerun the rollout${flag("--wait") ? "" : " with --wait"}`);
  }
  run("git", ["pull", "--ff-only", "-q", "origin", "main"]);
  run("bun", ["install"]);
  return true;
}

/** The files a Bun bundle of these entry points is built from, relative to the checkout. */
function bundleInputs(entries: readonly string[]) {
  const dir = mkdtempSync(join(tmpdir(), "rollout-bundle-"));
  try {
    execFileSync("bun", ["build", ...entries, "--target=bun", "--root", ".", "--outdir", join(dir, "out"), `--metafile=${join(dir, "meta.json")}`], { cwd: checkout, stdio: "ignore" });
    return Object.keys((JSON.parse(readFileSync(join(dir, "meta.json"), "utf8")) as { inputs: Record<string, unknown> }).inputs);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** Files changed between a commit and HEAD, or null when the commit is unknown here. */
function changedSince(commit: string | undefined) {
  if (!commit) return null;
  try {
    return git("diff", "--name-only", commit, "HEAD").split("\n").filter(Boolean);
  } catch {
    return null;
  }
}

async function afterPull() {
  process.chdir(checkout);
  process.loadEnvFile(".env.local");
  const head = git("rev-parse", "HEAD");

  run("bun", ["run", "db:migrate"]);

  // next build empties its output first, so build beside the .next the panel serves and swap it in. A failed
  // build stops the rollout here, with the runner still stopped and the panel on its old build.
  rmSync(join(checkout, ".next-rollout"), { recursive: true, force: true });
  process.env.HIVE_BUILD_DIR = ".next-rollout";
  run("bun", ["run", "build"]);
  delete process.env.HIVE_BUILD_DIR;
  rmSync(join(checkout, ".next-old"), { recursive: true, force: true });
  if (existsSync(join(checkout, ".next"))) renameSync(join(checkout, ".next"), join(checkout, ".next-old"));
  renameSync(join(checkout, ".next-rollout"), join(checkout, ".next"));
  log("restarting the panel");
  run("launchctl", ["kickstart", "-k", `gui/${userInfo().uid}/com.hive.panel`]);
  const panel = (process.env.FACTORY_PANEL_URL?.trim() || `http://localhost:${process.env.PANEL_PORT?.trim() || "3000"}`).replace(/\/+$/, "");
  log(`waiting for the panel at ${panel}`);
  await waitForPanel(`${panel}/auth/sign-in`, { timeoutMs: 120_000, everyMs: 2_000 });
  log("the panel answers 200");
  rmSync(join(checkout, ".next-old"), { recursive: true, force: true });

  const image = readSandboxImage();
  if (!image) log("image: none was ever built on this machine (no Modal jobs), not built");
  else {
    const problem = imageProblem(image, loadLimits().sandbox);
    const imageChanged = changedSince(image.factoryCommit);
    const imageTouched = imageChanged && touchedInputs(imageChanged, [...(bundleInputs(IMAGE_BUNDLES)), "scripts/sandbox-image.ts", "lib/sandbox-image-build.ts"]);
    const why = [problem, imageTouched === null ? `its commit ${image.factoryCommit.slice(0, 7)} is not in this checkout` : imageTouched.length > 0 && `${imageTouched.join(", ")} changed`].filter(Boolean);
    if (why.length > 0) {
      log(`image: rebuilding, ${why.join("; ")}`);
      run("bun", ["scripts/sandbox-image.ts"]);
    } else log(`image: ${image.imageId} is current (built from ${image.factoryCommit.slice(0, 7)})`);
  }

  const offset = existsSync(LOG_PATH) ? statSync(LOG_PATH).size : 0;
  run("bun", ["scripts/install-runner.ts"]);
  runnerStopped = false;
  log("waiting for the runner's first tick");
  const verdict = await waitFor("the runner's first tick", 15 * 60_000, 5_000, () => {
    const v = startupVerdict(readFrom(LOG_PATH, offset).split("\n"));
    return v.state === "waiting" ? undefined : v;
  });
  if (verdict.state === "failed") throw new StepError(`the runner came up unhealthy: ${verdict.why}`);
  log(`runner ticked cleanly at ${verdict.at}`);

  mkdirSync(dirname(ROLLOUT_PATH), { recursive: true });
  writeFileSync(ROLLOUT_PATH, `${JSON.stringify({ commit: head, at: new Date().toISOString() }, null, 2)}\n`);
  chmodSync(ROLLOUT_PATH, 0o600);
  log(`rolled out ${head.slice(0, 7)}; recorded in ${ROLLOUT_PATH}`);
}

function readFrom(path: string, offset: number) {
  if (!existsSync(path)) return "";
  const size = statSync(path).size;
  if (size <= offset) return "";
  const buffer = Buffer.alloc(size - offset);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buffer, 0, buffer.length, offset);
  } finally {
    closeSync(fd);
  }
  return buffer.toString("utf8");
}

try {
  if (flag("--after-pull")) await afterPull();
  else {
    if (await beforePull()) {
      // The pulled checkout's own rollout script does the rest, so a change to it applies at once.
      const next = existsSync(join(checkout, "scripts/rollout.ts")) ? join(checkout, "scripts/rollout.ts") : import.meta.filename;
      const rest = spawnSync("bun", [next, "--after-pull", ALREADY_STOPPED, "--checkout", checkout], { cwd: checkout, stdio: "inherit" });
      if (rest.status !== 0) process.exit(rest.status ?? 1);
      runnerStopped = false;
    }
    if (flag("--canary")) run("bun", [join(import.meta.dirname, "canary.ts"), "--checkout", checkout]);
  }
  process.exit(0);
} catch (error) {
  console.error(`rollout stopped: ${error instanceof Error ? error.message : String(error)}`);
  if (runnerStopped) console.error("The runner is stopped. Fix the cause and run the rollout again, or start the runner as it is with bun scripts/install-runner.ts.");
  if (!(error instanceof StepError) && error instanceof Error) console.error(error.stack);
  process.exit(1);
}
