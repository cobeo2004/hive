import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cpus, hostname, loadavg, totalmem } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { eq, sql } from "drizzle-orm";
import { db } from "../db/client";
import { machines } from "../db/schema";
import { loadConfig } from "../lib/config";
import { UNKNOWN, type Heartbeat, type Inventory } from "../lib/machine";
import { localHost } from "../lib/host";
import { sandboxReadiness } from "../lib/sandbox";
import { probeBrowser, probeDevices } from "../lib/t3-client";
import { connectStatus, readHarnesses, readProjects, readT3Runtime } from "../lib/t3-state";
import { baseImageBuild } from "./base-image";
import { message, withTimeout } from "./queue";
import { defaultsStatus } from "./sstack-defaults";

const run = promisify(execFile);
const RUNNER_DIR = join(import.meta.dirname, "..");
const text = async (cmd: string, args: string[], cwd?: string) => (await run(cmd, args, { cwd, timeout: 5_000, maxBuffer: 1024 * 1024 })).stdout;

type Machine = { id: string; name: string; idFrom: "config" | "ioreg" | "hostname" };

/** Falls back to the host name when ioreg fails, so the runner starts instead of crash-looping under launchd. */
export async function identify(override?: string): Promise<Machine> {
  const name =
    (await text("scutil", ["--get", "ComputerName"]).then(
      (out) => out.trim(),
      () => "",
    )) || hostname();
  if (override) return { id: override, name, idFrom: "config" };
  const uuid = await text("ioreg", ["-rd1", "-c", "IOPlatformExpertDevice"]).then(
    (out) => /"IOPlatformUUID" = "([^"]+)"/.exec(out)?.[1],
    () => undefined,
  );
  return uuid ? { id: uuid, name, idFrom: "ioreg" } : { id: `hostname:${hostname()}`, name, idFrom: "hostname" };
}

let machine: Promise<Machine> | undefined;
export const thisMachine = () => (machine ??= identify(loadConfig().factory.machineId));

/** macOS keeps "free" low on purpose, so memory in use excludes the pages the kernel can hand back at once. */
export function parseVmStat(output: string, totalBytes: number) {
  const pageSize = Number(/page size of (\d+) bytes/.exec(output)?.[1]);
  if (!(pageSize > 0)) throw new Error("vm_stat has no page size");
  const pages = (name: string) => {
    const value = /^Pages (\w+):\s+(\d+)\.$/gm;
    for (const match of output.matchAll(value)) if (match[1] === name) return Number(match[2]);
    throw new Error(`vm_stat has no "Pages ${name}" line`);
  };
  const reclaimable = pages("free") + pages("inactive") + pages("speculative") + pages("purgeable");
  const usedBytes = totalBytes - reclaimable * pageSize;
  if (usedBytes < 0) throw new Error("vm_stat reports more reclaimable memory than the machine has");
  return { usedBytes, totalBytes };
}

export function parseDf(output: string) {
  const [header, row] = output.trim().split("\n");
  if (!header?.startsWith("Filesystem") || !header.includes("1024-blocks") || !row) throw new Error("df output has no 1024-blocks table");
  const columns = row.trim().split(/\s+/);
  const totalKb = Number(columns[1]);
  const freeKb = Number(columns[3]);
  if (!Number.isFinite(totalKb) || !Number.isFinite(freeKb) || totalKb <= 0) throw new Error("df row has no block counts");
  return { freeBytes: freeKb * 1024, totalBytes: totalKb * 1024 };
}

type HeartbeatCollectors = { [K in keyof Heartbeat]: () => Promise<Heartbeat[K]> };
type InventoryCollectors = { [K in keyof Inventory]-?: () => Promise<Inventory[K]> };

const settle = <T>(collect: () => Promise<T>) => collect().catch((): typeof UNKNOWN => UNKNOWN);

export function systemCollectors(capacity: () => Promise<Heartbeat["capacity"]>): HeartbeatCollectors {
  return {
    cpu: async () => ({ load1: loadavg()[0]!, cores: cpus().length }),
    memory: async () => parseVmStat(await text("vm_stat", []), totalmem()),
    disk: async () => parseDf(await text("df", ["-k", "/System/Volumes/Data"])),
    capacity,
    sstackDefaults: async () => defaultsStatus() ?? UNKNOWN,
  };
}

export async function collectHeartbeat(collectors: HeartbeatCollectors): Promise<Heartbeat> {
  const [cpu, memory, disk, capacity, sstackDefaults] = await Promise.all([
    settle(collectors.cpu),
    settle(collectors.memory),
    settle(collectors.disk),
    settle(collectors.capacity),
    collectors.sstackDefaults && settle(collectors.sstackDefaults),
  ]);
  return { cpu, memory, disk, capacity, ...(sstackDefaults !== undefined && { sstackDefaults }) };
}

export function parseOrigin(url: string) {
  return /[:/]([^/:]+)\/([^/]+?)(?:\.git)?\/?$/.exec(url.trim())?.slice(1).join("/");
}

export function inventoryCollectors(): InventoryCollectors {
  const { factory } = loadConfig();
  return {
    runnerSha: async () => (await text("git", ["rev-parse", "HEAD"], RUNNER_DIR)).trim(),
    t3: async () => readT3Runtime(),
    connect: connectStatus,
    projects: () => readProjects({ statePath: factory.t3StatePath, repos: factory.repos }),
    repos: async () =>
      Promise.all(
        factory.repos.map(async (path) => ({
          path,
          origin: await text("git", ["-C", path, "remote", "get-url", "origin"]).then(
            (url) => parseOrigin(url) ?? UNKNOWN,
            () => UNKNOWN,
          ),
        })),
      ),
    harnesses: async () => readHarnesses(),
    sandbox: async () => {
      const imageBuild = baseImageBuild();
      return { ...sandboxReadiness(factory.sandbox), ...(imageBuild && { imageBuild }) };
    },
    slack: async () => ({ configured: Boolean(process.env.SLACK_BOT_TOKEN?.trim()), owner: Boolean(process.env.SLACK_OWNER_USER_ID?.trim()) }),
    devices: () => probeDevices(localHost),
    browser: () => probeBrowser(localHost),
  };
}

/** A T3 probe that stalls is unknown after this, well inside the 60 s beat. */
const PROBE_MS = 30_000;

/**
 * A probe still running from an earlier beat: the next beat reports unknown instead of starting another, so a
 * stalled T3 never piles up sessions. A timeout cannot cancel the call; withMcp's CLI timeouts end it and its
 * finally revokes the session. ponytail: no AbortSignal through withMcp; add one if a probe outlives those timeouts.
 */
const inFlight = new WeakMap<() => Promise<unknown>, Promise<unknown>>();

export async function collectInventory(collectors: InventoryCollectors, probeMs = PROBE_MS): Promise<Inventory> {
  const probe = <T>(collect: () => Promise<T>) => {
    if (inFlight.has(collect)) return Promise.resolve<typeof UNKNOWN>(UNKNOWN);
    const running = collect();
    inFlight.set(collect, running);
    running.then(
      () => inFlight.delete(collect),
      () => inFlight.delete(collect),
    );
    return settle(() =>
      withTimeout(
        () => running,
        probeMs,
        () => {},
      ),
    );
  };
  const [runnerSha, t3, connect, projects, repos, harnesses, sandbox, slack, devices, browser] = await Promise.all([
    settle(collectors.runnerSha),
    settle(collectors.t3),
    settle(collectors.connect),
    collectors.projects().catch((): Inventory["projects"] => ({ source: UNKNOWN })),
    collectors.repos().catch((): Inventory["repos"] => []),
    settle(collectors.harnesses),
    settle(collectors.sandbox),
    settle(collectors.slack),
    probe(collectors.devices),
    probe(collectors.browser),
  ]);
  return { runnerSha, t3, connect, projects, repos, harnesses, sandbox, slack, devices, browser };
}

export async function writeHeartbeat(machine: Machine, heartbeat: Heartbeat, now: Date) {
  await db
    .insert(machines)
    .values({ id: machine.id, name: machine.name, last_seen_at: now, heartbeat })
    .onConflictDoUpdate({ target: machines.id, set: { name: machine.name, last_seen_at: now, heartbeat } });
}

/**
 * `fill` is whether inventory_at was already null when this collection began. Only then does the write answer
 * a "Check now"; a click that nulled it mid-collection is still owed an inventory, so the write keeps the null.
 */
export async function writeInventory(machineId: string, inventory: Inventory, now: Date, fill = true) {
  const at = fill ? now : sql`case when ${machines.inventory_at} is null then null else ${now.toISOString()}::timestamptz end`;
  const updated = await db.update(machines).set({ inventory, inventory_at: at }).where(eq(machines.id, machineId)).returning({ id: machines.id });
  return updated.length > 0;
}

const hashOf = (inventory: Inventory) => createHash("sha256").update(JSON.stringify(inventory)).digest("hex");

export function inventoryReporter(write: (inventory: Inventory, fill: boolean) => Promise<boolean>) {
  let written: string | undefined;
  /** `fill` writes an unchanged inventory too, so a "Check now" always lands a new inventory_at. */
  return async (inventory: Inventory, fill = false): Promise<"written" | "unchanged" | "missing"> => {
    const hash = hashOf(inventory);
    if (hash === written && !fill) return "unchanged";
    if (!(await write(inventory, fill))) return "missing";
    written = hash;
    return "written";
  };
}

type Log = (event: string, detail?: Record<string, unknown>) => void;

export function createBeat({
  machine,
  heartbeatCollectors,
  inventoryCollectors: inventory,
  inventoryMs,
  timeoutMs = 60_000,
  log,
  now = Date.now,
}: {
  machine: Machine;
  heartbeatCollectors: HeartbeatCollectors;
  inventoryCollectors: InventoryCollectors;
  inventoryMs: number;
  /** A stalled collector or pool must not hold `running` forever and skip every later beat. */
  timeoutMs?: number;
  log: Log;
  now?: () => number;
}) {
  const report = inventoryReporter((value, fill) => writeInventory(machine.id, value, new Date(now()), fill));
  let running = false;
  let inventoryAt: number | undefined;
  /** Bumped by each fresh request, so an inventory collected before it does not count as fresh. */
  let freshAsked = 0;
  async function beatOnce(withInventory: boolean) {
    const started = now();
    const heartbeat = await collectHeartbeat(heartbeatCollectors);
    await writeHeartbeat(machine, heartbeat, new Date(now()));
    log("heartbeat", {
      ms: now() - started,
      unknown: Object.entries(heartbeat)
        .filter(([, v]) => v === UNKNOWN)
        .map(([k]) => k),
    });
    if (!withInventory || (inventoryAt !== undefined && now() - inventoryAt < inventoryMs)) return;
    const collectedAt = now();
    const asked = freshAsked;
    // Read before collecting: a Check now (or a new machine's row) already null now is answered by this collection.
    const fill = await inventoryStale(machine.id);
    const result = await report(await collectInventory(inventory), fill);
    if (result !== "missing" && asked === freshAsked) inventoryAt = collectedAt;
    log("inventory", { ms: now() - collectedAt, result });
  }

  /**
   * `inventory: false` writes only the heartbeat, for the startup beat that runs before the reconcile;
   * `fresh` collects the inventory now, for a change the panel should not wait inventoryMinutes for.
   */
  return async function beat({ inventory: withInventory = true, fresh = false } = {}) {
    if (fresh) {
      freshAsked++;
      inventoryAt = undefined;
    }
    if (running) {
      log("heartbeat:skipped", { reason: "the previous beat is still running" });
      return false;
    }
    running = true;
    try {
      await withTimeout(
        () => beatOnce(withInventory),
        timeoutMs,
        (error) => log("heartbeat:late-error", { error: message(error) }),
      );
    } catch (error) {
      log("heartbeat:error", { error: message(error) });
    } finally {
      running = false;
    }
    return true;
  };
}

/** True when the panel's "Check now" nulled this machine's inventory_at and no inventory has landed since. */
export async function inventoryStale(machineId: string) {
  const [row] = await db.select({ at: machines.inventory_at }).from(machines).where(eq(machines.id, machineId));
  return row !== undefined && row.at === null;
}

/**
 * The runner's handler for a machines notification. hive_changes names only the table, so it reads its own
 * row and another machine's change runs nothing here. One check at a time, so the heartbeats that notify
 * while the fresh inventory runs start no second one.
 */
export function checkNowWatcher(
  stale: () => Promise<boolean>,
  /** False when it was skipped because a beat was already running; that beat's write notifies again. */
  beat: (options: { fresh: true }) => Promise<boolean>,
  log: Log,
  { now = Date.now, retryMs = 60_000 } = {},
) {
  let checking: Promise<unknown> | undefined;
  let failedAt = Number.NEGATIVE_INFINITY;
  return () =>
    (checking ??= (async () => {
      if (now() - failedAt < retryMs || !(await stale())) return;
      // A fresh inventory that ran and still did not land (a failing write) waits retryMs before the next
      // try, so the heartbeats' own notifications do not loop it.
      if ((await beat({ fresh: true })) && (await stale())) failedAt = now();
    })()
      .catch((error) => log("checkNow:error", { error: message(error) }))
      .finally(() => (checking = undefined)));
}
