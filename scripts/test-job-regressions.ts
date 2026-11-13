import "./test-guard";
import assert from "node:assert/strict";
import { checks, testJobDescription } from "../lib/test-job";

type Args = Parameters<typeof checks>;
const evidence: NonNullable<Args[4]> = {
  clean: true,
  producer: "agent",
  checks: [{ name: "test", command: "bun test", exitCode: 0, startedAt: "2026-11-14T00:00:00Z", durationMs: 1, outputTail: "", passed: true }],
};
const decision = { outcome: "handover", reasons: ["Has the review label."] } as NonNullable<Args[1]["merge_decision"]>;
const head = { sha: "a".repeat(40), state: "OPEN" };
const pr_url = "https://github.com/o/r/pull/1";
const browserJob: Args[1] = { execution: "modal", sandbox_id: "sb-1", sandbox_snapshot: null, machine_id: null, merge_decision: decision, pr_url };
const devicesJob: Args[1] = { ...browserJob, execution: "local", sandbox_id: null, machine_id: "mac-1" };
const deviceMedia = ["after-browser.png", "after-ios.png", "after-android.png"];

const failing = (...a: Args) =>
  checks(...a)
    .filter((c) => !c.ok)
    .map((c) => c.name);

// browser: the canary's original checks, each failing alone.
const browser = (job: Partial<Args[1]>, h: Args[2] = head, media = ["after-page.png"], ev: Args[4] | null = evidence) =>
  failing("browser", { ...browserJob, ...job }, h, media, ev ?? undefined);
assert.deepEqual(browser({}), [], "a finished browser job passes every check");
assert.deepEqual(browser({ sandbox_id: null, sandbox_snapshot: "snap" }), [], "a snapshot sandbox counts");
assert.deepEqual(browser({ execution: "local" }), ["launched in a sandbox"]);
assert.deepEqual(browser({ sandbox_id: null }), ["launched in a sandbox"]);
assert.deepEqual(browser({}, { ...head, state: "MERGED" }), ["opened a PR"]);
assert.deepEqual(browser({}, head, []), ["media attached"]);
assert.deepEqual(browser({}, head, ["after-page.png"], null), ["factory-verify passed at the head"]);
assert.deepEqual(browser({}, head, ["after-page.png"], { ...evidence, clean: false }), ["factory-verify passed at the head"]);
assert.deepEqual(browser({}, head, ["after-page.png"], { ...evidence, producer: "runner" }), ["factory-verify passed at the head"]);
assert.deepEqual(browser({}, head, ["after-page.png"], { ...evidence, checks: [] }), ["factory-verify passed at the head"]);
assert.deepEqual(browser({}, head, ["after-page.png"], { ...evidence, checks: [{ ...evidence.checks[0]!, exitCode: 1 }] }), [
  "factory-verify passed at the head",
]);
assert.deepEqual(browser({ merge_decision: { ...decision, outcome: "merge" } }), ["handed over, not merged"]);
assert.deepEqual(browser({ merge_decision: { ...decision, merged: {} } as typeof decision }), ["handed over, not merged"]);
assert.deepEqual(browser({ merge_decision: null }), ["handed over, not merged"]);
assert.deepEqual(
  browser({ pr_url: null }, null, ["after-page.png"], null),
  ["opened a PR", "factory-verify passed at the head"],
  "no PR, so no evidence at its head either",
);

// devices: local on a pool Mac, three media files.
const devices = (job: Partial<Args[1]>, media = deviceMedia, ev: Args[4] | null = evidence) =>
  failing("devices", { ...devicesJob, ...job }, head, media, ev ?? undefined);
assert.deepEqual(devices({}), [], "a finished devices job passes every check");
assert.deepEqual(devices({ execution: "modal" }), ["ran local on a pool Mac"]);
assert.deepEqual(devices({ machine_id: null }), ["ran local on a pool Mac"]);
assert.deepEqual(devices({ sandbox_id: "sb-1" }), ["ran local on a pool Mac"]);
assert.deepEqual(devices({ sandbox_snapshot: "snap" }), ["ran local on a pool Mac"]);
for (const file of deviceMedia)
  assert.deepEqual(
    devices(
      {},
      deviceMedia.filter((f) => f !== file),
    ),
    ["browser, iOS and Android media attached"],
    `${file} missing`,
  );
assert.deepEqual(devices({}, ["after-page.png"]), ["browser, iOS and Android media attached"], "the browser canary's media is not enough");
assert.deepEqual(devices({}, deviceMedia, null), ["factory-verify passed at the head"]);
assert.deepEqual(devices({ merge_decision: { ...decision, outcome: "merge" } }), ["handed over, not merged"]);
assert.deepEqual(failing("devices", devicesJob, { ...head, state: "CLOSED" }, deviceMedia, evidence), ["opened a PR"]);

// The tickets name what the checks look for.
const browserTicket = testJobDescription("browser");
assert.match(browserTicket, /`playwright` browser/);
assert.match(browserTicket, /after-page\.png/);
const devicesTicket = testJobDescription("devices");
for (const file of deviceMedia) assert.ok(devicesTicket.includes(file), `the devices ticket asks for ${file}`);
assert.match(devicesTicket, /10\.0\.2\.2/, "the emulator reaches the host through 10.0.2.2");
assert.match(devicesTicket, /only the simulators and emulators you booted/);
assert.match(devicesTicket, /factory-verify/);

console.log("test-job regressions passed");
