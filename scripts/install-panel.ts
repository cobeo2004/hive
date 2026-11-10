import { homedir } from "node:os";
import { join } from "node:path";
import { installLaunchAgent, pathWith, plistPath, uninstallLaunchAgent, which } from "../lib/launch-agent";

// Installs the panel as a launchd LaunchAgent (R2): `bun run start` in this checkout, started at
// login and restarted when it exits, logging to ~/Library/Logs/marshal-factory/panel.log. `next
// start` reads .env.local itself, so the agent carries no settings. Re-running with nothing changed
// leaves it alone.
//   bun scripts/install-panel.ts [--uninstall]

export const LABEL = "com.hive.panel";
const root = join(import.meta.dirname, "..");
const logPath = join(homedir(), "Library/Logs/marshal-factory/panel.log");
const port = process.env.PANEL_PORT?.trim() || "3000";

if (process.argv.includes("--uninstall")) {
  uninstallLaunchAgent(LABEL);
  console.log(`unloaded  ${LABEL}; ${plistPath(LABEL)} left in place`);
  process.exit(0);
}

const state = installLaunchAgent({
  label: LABEL,
  programArguments: [which("bun"), "run", "start", "--", "-p", port],
  workingDirectory: root,
  environment: { PATH: pathWith("bun"), HOME: homedir() },
  logPath,
});
console.log(`${state} ${LABEL}; port ${port} in ${root}; log ${logPath}`);
