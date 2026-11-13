import { execFile } from "node:child_process";
import { closeSync, mkdirSync, mkdtempSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { ModalClient } from "modal";
import { SANDBOX_IMAGE_PATH, type SandboxLimits } from "./config";
import { imageDrift, rebuildText, type ImageVersions } from "./machine";
import type { SandboxHandle } from "./modal-host";
import {
  FACTORY_ROOT,
  GITHUB_TOKEN_PATH,
  IMAGE_BUNDLES,
  installPlaybooks,
  parseVersion,
  pinnedVersions,
  PLAYBOOK_FILES,
  SANDBOX_HOME,
  SANDBOX_PLAYBOOKS,
  SSTACK_DIR,
  sstackVersion,
  type SandboxImage,
} from "./sandbox";
import { forbidInTest } from "./test-mode";

// Builds the image factory sandboxes launch from, and records its id for the runner. The CLI
// (scripts/sandbox-image.ts) and the runner, when its pins drift from the stored image, both call it.
// The base layers come from Dockerfile commands and Modal caches them. The factory's hook and MCP
// entry points are bundled here with Bun, one self-contained file each at the path the wiring
// names, so the sandbox needs no checkout and no install; `factory-verify` on PATH runs
// hooks/verify.ts. A sandbox from the base gets those files and the factory's playbooks,
// and its filesystem snapshot, kept indefinitely, is the image. T3, Claude Code, Codex, the Cursor CLI, Playwright MCP and sstack
// install at the versions factory.sandbox pins, and the build fails unless the sandbox reports
// exactly those, holds this checkout's playbooks and runs the hook bundles; only then is the new
// image id written, so a failed build leaves the old image in place.

const execFileAsync = promisify(execFile);
const ROOT = join(import.meta.dirname, "..");

const b64 = (text: string) => Buffer.from(text).toString("base64");
const install = (path: string, text: string) => `RUN echo ${b64(text)} | base64 -d > ${path} && chmod 755 ${path}`;

// The job's GitHub token lives in one file, so a refresh is a rewrite; git and gh both read it per call.
const credentialHelper = `#!/bin/sh
test "$1" = get || exit 0
echo username=x-access-token
echo "password=$(cat ${GITHUB_TOKEN_PATH})"
`;
const ghWrapper = `#!/bin/sh
GH_TOKEN="$(cat ${GITHUB_TOKEN_PATH} 2>/dev/null)" exec /usr/bin/gh "$@"
`;
const verifyWrapper = `#!/bin/sh
exec bun ${FACTORY_ROOT}/hooks/verify.ts "$@"
`;

export type BuildLimits = Pick<
  SandboxLimits,
  "appName" | "t3Version" | "claudeCodeVersion" | "codexVersion" | "cursorAgentVersion" | "playwrightMcpVersion" | "sstack"
>;
type Log = (message: string) => void;
/** Starts the build sandbox from the base layers; regressions pass a fake one. */
type OpenBuildSandbox = (limits: BuildLimits, log: Log) => Promise<SandboxHandle>;

/** Where sstack-install links sstack's skills: Claude's, and the one Codex reads. */
const SKILL_DIRS = [`${SANDBOX_HOME}/.claude/skills`, `${SANDBOX_HOME}/.agents/skills`];

/** The Dockerfile commands for the base layers, at the pinned versions. */
export const baseLayers = (limits: BuildLimits) => [
  "RUN apt-get update && apt-get install -y --no-install-recommends git curl ca-certificates procps unzip ffmpeg && rm -rf /var/lib/apt/lists/*",
  "RUN curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg -o /usr/share/keyrings/githubcli-archive-keyring.gpg" +
    ' && echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" > /etc/apt/sources.list.d/github-cli.list' +
    " && apt-get update && apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*",
  "RUN curl -fsSL https://bun.sh/install | BUN_INSTALL=/usr/local bash",
  `RUN curl -fsSL https://t3.codes/install.sh | T3CODE_VERSION=${limits.t3Version} T3CODE_INSTALL_BIN_DIR=/usr/local/bin sh`,
  `RUN npm i -g @anthropic-ai/claude-code@${limits.claudeCodeVersion} @openai/codex@${limits.codexVersion}`,
  // Cursor's installer (cursor.com/install) always fetches its latest build and checks no sum; this fetches the same tarball at the pinned one and checks its sha256.
  cursorAgentLayer(limits.cursorAgentVersion),
  // The playwright CLI bundled with the pinned package installs the Chromium that exact version drives, with its OS libraries.
  `RUN npm i -g @playwright/mcp@${limits.playwrightMcpVersion} && cd "$(npm root -g)/@playwright/mcp" && npx --no-install playwright install --with-deps chromium && rm -rf /var/lib/apt/lists/*`,
  // sstack-install links skills only into skill dirs and instruction files that exist; Codex reads ~/.agents/skills.
  `RUN git init -q ${SSTACK_DIR} && git -C ${SSTACK_DIR} fetch -q --depth 1 https://github.com/${limits.sstack.repo}.git ${limits.sstack.commit}` +
    ` && git -C ${SSTACK_DIR} checkout -q FETCH_HEAD` +
    ` && mkdir -p ${SKILL_DIRS.join(" ")} ${SANDBOX_HOME}/.codex && touch ${SANDBOX_HOME}/.claude/CLAUDE.md ${SANDBOX_HOME}/.codex/AGENTS.md` +
    ` && ${SSTACK_DIR}/bin/sstack-install && ln -s ${SSTACK_DIR}/bin/sstack-* /usr/local/bin/`,
  install("/usr/local/bin/git-credential-factory", credentialHelper),
  install("/usr/local/bin/gh", ghWrapper),
  install("/usr/local/bin/factory-verify", verifyWrapper),
  "RUN git config --global user.name marshal-factory && git config --global user.email marshal-factory@users.noreply.github.com" +
    " && git config --global credential.https://github.com.helper factory && git config --global init.defaultBranch main",
];

const openModalBuildSandbox: OpenBuildSandbox = async (limits, log) => {
  forbidInTest("Modal");
  const modal = new ModalClient();
  try {
    const app = await modal.apps.fromName(limits.appName, { createIfMissing: true });
    // The caller holds this machine's build lock, so a build sandbox of this machine still running
    // was left by a build that stopped mid-create; it is ended rather than billed until its timeout.
    const tags = { purpose: "image-build", host: hostname() };
    for await (const left of modal.sandboxes.list({ appId: app.appId, tags })) {
      log(`ending build sandbox ${left.sandboxId}, left by an earlier build`);
      await left.terminate().catch((error: unknown) => log(`could not end ${left.sandboxId}: ${String(error)}`));
    }
    const base = modal.images.fromRegistry("node:22-bookworm").dockerfileCommands(baseLayers(limits));
    log("building the base image (the first build takes a few minutes)");
    const sandbox = await modal.sandboxes.create(app, base, {
      name: `image-build-${Date.now()}`,
      tags,
      runtime: "gvisor",
      timeoutMs: 20 * 60_000,
      command: ["sleep", "infinity"],
    });
    // The client goes with the sandbox, so a runner building again later opens a fresh one.
    const terminate = sandbox.terminate.bind(sandbox);
    return Object.assign(sandbox, { terminate: () => terminate().finally(() => modal.close()) });
  } catch (error) {
    modal.close();
    throw error;
  }
};

async function sh(sandbox: SandboxHandle, script: string, timeoutMs = 120_000) {
  const proc = await sandbox.exec(["bash", "-c", script], { timeoutMs });
  const [out, err, code] = await Promise.all([proc.stdout.readText(), proc.stderr.readText(), proc.wait()]);
  if (code !== 0) throw new Error(`${script} exited ${code}: ${err.trim().slice(-500)}`);
  return out.trim();
}

/**
 * sstack as the image holds it: the checkout's commit prefix when its skills are linked for both CLIs
 * and sstack-wiki runs from PATH (outside a repo it finds no wiki and exits 0), else undefined.
 */
async function sstackInImage(sandbox: SandboxHandle, log: Log) {
  const commit = await sh(sandbox, `git -C ${SSTACK_DIR} rev-parse HEAD`);
  const linked = await Promise.all(SKILL_DIRS.map(async (dir) => Number(await sh(sandbox, `find ${dir} -maxdepth 1 -lname '${SSTACK_DIR}/*' | wc -l`))));
  const wiki = await sh(sandbox, "cd /tmp && sstack-wiki lint");
  log(`sstack at ${sstackVersion(commit)}: ${linked.join(" and ")} skills in ${SKILL_DIRS.join(" and ")}; sstack-wiki: ${wiki}`);
  return linked.every((n) => n > 0) && wiki.includes("no wiki") ? sstackVersion(commit) : undefined;
}

/** Writes through a temp file and a rename, owner-only, so a runner reading it never sees half a file. */
function writeImage(path: string, state: SandboxImage) {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, path);
}

/** A build holds this file for its whole run, so the runner and the CLI never build at once on one machine. */
export const buildLockPath = (path: string) => `${path}.lock`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
};

/** Takes the build lock, or returns the pid of the live process that holds it. A dead holder's lock is taken over. */
function lock(path: string): { release: () => void } | { heldBy: number } {
  const lockPath = buildLockPath(path);
  mkdirSync(dirname(lockPath), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      writeFileSync(fd, String(process.pid));
      closeSync(fd);
      return { release: () => rmSync(lockPath, { force: true }) };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const holder = Number(readFileSync(lockPath, "utf8"));
      if (holder > 0 && alive(holder)) return { heldBy: holder };
      rmSync(lockPath, { force: true });
    }
  }
  throw new Error(`could not take the build lock ${lockPath}`);
}

export class BuildLockedError extends Error {
  constructor(readonly pid: number) {
    super(`another sandbox image build (pid ${pid}) is running on this machine`);
  }
}

/**
 * Builds, verifies and records a new image under these pins. Throws without touching the stored
 * image when the build or its verification fails, or when another build holds the lock.
 */
export async function buildSandboxImage({
  limits,
  log,
  open = openModalBuildSandbox,
  path = SANDBOX_IMAGE_PATH,
  signal,
}: {
  limits: BuildLimits;
  log: Log;
  open?: OpenBuildSandbox;
  path?: string;
  /** Aborting ends the build sandbox, at once or as soon as its create returns, so the build fails and records nothing. */
  signal?: AbortSignal;
}): Promise<SandboxImage> {
  const held = lock(path);
  if ("heldBy" in held) throw new BuildLockedError(held.heldBy);
  let bundleDir: string | undefined;
  let sandbox: SandboxHandle | undefined;
  try {
    bundleDir = mkdtempSync(join(tmpdir(), "factory-bundle-"));
    await execFileAsync("bun", ["build", ...IMAGE_BUNDLES, "--target=bun", "--root", ".", "--outdir", bundleDir, "--entry-naming", "[dir]/[name].ts"], {
      cwd: ROOT,
    });
    log(`bundled ${IMAGE_BUNDLES.join(", ")}`);
    if (signal?.aborted) throw new Error("the build was stopped");
    sandbox = await open(limits, log);
    log(`build sandbox ${sandbox.sandboxId} up`);
    const opened = sandbox;
    const end = () => void opened.terminate().catch(() => {});
    signal?.addEventListener("abort", end, { once: true });
    if (signal?.aborted) end();
    for (const entry of IMAGE_BUNDLES) await sandbox.filesystem.writeText(readFileSync(join(bundleDir, entry), "utf8"), join(FACTORY_ROOT, entry));
    const playbooks = await installPlaybooks(sandbox.filesystem);
    log(`playbooks ${PLAYBOOK_FILES.join(", ")} in ${SANDBOX_PLAYBOOKS} at ${playbooks}`);
    const pinned = pinnedVersions(limits);
    const built: ImageVersions = {
      t3: parseVersion("t3", await sh(sandbox, "t3 --version")) ?? undefined,
      claudeCode: parseVersion("claudeCode", await sh(sandbox, "claude --version")) ?? undefined,
      codex: parseVersion("codex", await sh(sandbox, "codex --version")) ?? undefined,
      cursorAgent: parseVersion("cursorAgent", await sh(sandbox, "cursor-agent --version")) ?? undefined,
      playwrightMcp: parseVersion("playwrightMcp", await sh(sandbox, "playwright-mcp --version")) ?? undefined,
      sstack: await sstackInImage(sandbox, log),
      playbooks,
    };
    const drift = imageDrift(built, pinned);
    if (drift.length > 0) throw new Error(`the build sandbox does not match the pins: ${rebuildText(drift)}`);
    log(
      `versions: ${Object.entries(built)
        .map(([component, version]) => `${component} ${version}`)
        .join(" | ")} | bun ${await sh(sandbox, "bun --version")} | ${(await sh(sandbox, "ffmpeg -version")).split("\n")[0]}`,
    );
    await sh(sandbox, `cd /tmp && echo '{}' | bun ${FACTORY_ROOT}/hooks/report.ts && echo '{}' | bun ${FACTORY_ROOT}/hooks/budget.ts`);
    // Outside a git repo factory-verify refuses with exit 2, which shows the bundle loads.
    await sh(sandbox, `cd /tmp && { factory-verify --no-post 2>/dev/null; test $? -eq 2; }`);
    log("hook bundles run");

    // A stop from here on ends the sandbox under the snapshot, which then fails; one after it records the image, which passed every check.
    const image = await sandbox.snapshotFilesystem({ ttlMs: null, timeoutMs: 300_000 });
    const factoryCommit = (await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: ROOT })).stdout.trim();
    const state: SandboxImage = { imageId: image.imageId, t3Version: limits.t3Version, versions: pinned, factoryCommit, builtAt: new Date().toISOString() };
    writeImage(path, state);
    log(`image ${image.imageId} recorded in ${path}`);
    return state;
  } finally {
    await sandbox?.terminate().catch((error: unknown) => log(`could not terminate the build sandbox: ${String(error)}`));
    if (bundleDir) rmSync(bundleDir, { recursive: true, force: true });
    held.release();
  }
}

/** sha256 of Cursor's linux tarballs per pinned version: its installer checks none, so the image does. Bumping cursorAgentVersion needs both. */
const CURSOR_AGENT_SHA256: Record<string, { x64: string; arm64: string }> = {
  "2026.11.11-b912975": {
    x64: "be01f42ad334f81d05a9992fcf060a52cc746f52cc451e849eb652146a6e3c91",
    arm64: "f068af64ed91b5304605976586f690579679f740a41f388091a6b3a2e776987c",
  },
};

function cursorAgentLayer(version: string) {
  const sha = CURSOR_AGENT_SHA256[version];
  if (!sha) throw new Error(`no sha256 pinned for cursor-agent ${version}; add it to CURSOR_AGENT_SHA256`);
  return (
    `RUN arch=$(uname -m | sed 's/x86_64/x64/;s/aarch64/arm64/') && case $arch in x64) sum=${sha.x64};; arm64) sum=${sha.arm64};; *) exit 1;; esac` +
    ` && curl -fsSL -o /tmp/cursor-agent.tgz "https://downloads.cursor.com/lab/${version}/linux/$arch/agent-cli-package.tar.gz"` +
    ` && echo "$sum  /tmp/cursor-agent.tgz" | sha256sum -c - && mkdir -p /usr/local/lib/cursor-agent` +
    " && tar --strip-components=1 -xzf /tmp/cursor-agent.tgz -C /usr/local/lib/cursor-agent && rm /tmp/cursor-agent.tgz" +
    " && ln -s /usr/local/lib/cursor-agent/cursor-agent /usr/local/bin/cursor-agent && ln -s /usr/local/lib/cursor-agent/cursor-agent /usr/local/bin/agent"
  );
}
