import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { installLaunchAgent, pathWith, plistPath, uninstallLaunchAgent, which } from "../lib/launch-agent";

// Installs the runner as a launchd LaunchAgent: started at login, restarted when it exits, logging
// to ~/Library/Logs/marshal-factory/runner.log. Re-running with nothing changed leaves it alone.
//   bun scripts/install-runner.ts [--uninstall]

export const LABEL = "com.marshal-factory.runner";
const root = join(import.meta.dirname, "..");
const logPath = join(homedir(), "Library/Logs/marshal-factory/runner.log");

if (process.argv.includes("--uninstall")) {
  uninstallLaunchAgent(LABEL);
  console.log(`unloaded  ${LABEL}; ${plistPath(LABEL)} left in place`);
  process.exit(0);
}

// launchd starts with a bare PATH, so carry the directories of every tool the runner calls.
const tools = ["bun", "git"].map(which);
// T3 exports its CLI path only to sessions it starts; the daemon gets it from here.
// T3 installs its launcher at ~/.t3/bin/t3 and puts it on the login shell's PATH; launchd has neither.
const t3 = process.env.T3CODE_CLI_PATH ?? [join(homedir(), ".t3/bin/t3")].find(existsSync) ?? which("t3");
const state = installLaunchAgent({
  label: LABEL,
  programArguments: [tools[0]!, join(root, "runner/index.ts")],
  workingDirectory: root,
  environment: { PATH: pathWith("bun", "git"), HOME: homedir(), T3CODE_CLI_PATH: t3 },
  logPath,
});
console.log(`${state} ${LABEL}; log ${logPath}`);
