import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, join } from "node:path";

// The LaunchAgent plumbing the runner and panel installers share (R2): the plist for one label, and
// the bootout, bootstrap and "unchanged" rules that keep a reinstall from restarting a healthy service.

type LaunchAgent = {
  label: string;
  /** argv[0] is the program; the rest are its arguments, run without a shell. */
  programArguments: readonly string[];
  workingDirectory: string;
  environment?: Readonly<Record<string, string>>;
  logPath: string;
};

/** Where launchd reads the agent from. */
export const plistPath = (label: string) => join(homedir(), "Library/LaunchAgents", `${label}.plist`);

const domain = `gui/${userInfo().uid}`;
const launchctl = (...args: string[]) => execFileSync("/bin/launchctl", args, { encoding: "utf8", stdio: "pipe" });
const loaded = (label: string) => {
  try {
    launchctl("print", `${domain}/${label}`);
    return true;
  } catch {
    return false;
  }
};
const escape = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export const which = (bin: string) => execFileSync("/usr/bin/which", [bin], { encoding: "utf8" }).trim();

/** launchd starts a daemon with a bare PATH, so carry the directories of every tool it calls. */
export const pathWith = (...tools: readonly string[]) =>
  [...new Set([...tools.map((tool) => dirname(which(tool))), "/usr/bin", "/bin", "/usr/sbin", "/sbin"])].join(":");

function plistFor(agent: LaunchAgent): string {
  const env = Object.entries(agent.environment ?? {});
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${agent.label}</string>
  <key>ProgramArguments</key>
  <array>${agent.programArguments.map((argument) => `<string>${escape(argument)}</string>`).join("")}</array>
  <key>WorkingDirectory</key><string>${escape(agent.workingDirectory)}</string>${
    env.length > 0
      ? `
  <key>EnvironmentVariables</key>
  <dict>
${env.map(([name, value]) => `    <key>${escape(name)}</key><string>${escape(value)}</string>`).join("\n")}
  </dict>`
      : ""
  }
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${escape(agent.logPath)}</string>
  <key>StandardErrorPath</key><string>${escape(agent.logPath)}</string>
</dict>
</plist>
`;
}

/** Writes the plist when it changed and bootstraps the agent; "installed", "unchanged" or "loaded". */
export function installLaunchAgent(agent: LaunchAgent): "installed" | "unchanged" | "loaded" {
  const path = plistPath(agent.label);
  const plist = plistFor(agent);
  mkdirSync(dirname(path), { recursive: true });
  mkdirSync(dirname(agent.logPath), { recursive: true });
  const changed = !existsSync(path) || readFileSync(path, "utf8") !== plist;
  if (changed) writeFileSync(path, plist);
  if (changed && loaded(agent.label)) {
    launchctl("bootout", `${domain}/${agent.label}`);
    // bootout returns before the old process is gone; bootstrap fails until it is.
    for (let i = 0; i < 50 && loaded(agent.label); i++) execFileSync("/bin/sleep", ["0.2"]);
  }
  const wasLoaded = loaded(agent.label);
  if (changed || !wasLoaded) launchctl("bootstrap", domain, path);
  return changed ? "installed" : wasLoaded ? "unchanged" : "loaded";
}

/** Unloads the agent; its plist stays in place for the next install. */
export function uninstallLaunchAgent(label: string) {
  if (loaded(label)) launchctl("bootout", `${domain}/${label}`);
}
