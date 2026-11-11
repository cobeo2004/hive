import "./test-guard";
import assert from "node:assert/strict";
import type { SessionUser } from "../lib/auth/owner";

const { db } = await import("../db/client");
const { linearSettings: table } = await import("../db/schema");
const { readSourceChoice, saveSourceChoice, sourcesOn, writeSourceChoice } = await import("../lib/job-sources");
const { linearSettings, saveLinearSettings } = await import("../lib/linear-settings");
const { parseConfig, requireLinearKey } = await import("../lib/config");
const { createLinearAdapter } = await import("../lib/sources/linear");
const { github } = await import("../lib/sources/github");

// Where jobs come from (R13, R14): one choice in the Linear settings row, Linear alone until an admin makes it.
await db.delete(table);
assert.deepEqual(await sourcesOn(db, {}), { linear: true, github: false }, "no row: Linear alone, as every install ran before the choice");
assert.deepEqual(await sourcesOn(db, { FACTORY_GITHUB_ISSUES: "on" }), { linear: true, github: true }, "the env var still turns GitHub on beside it");
assert.deepEqual(await github.ready(), [], "GitHub Issues is off by default, and the poll does not call GitHub");

const at = new Date("2026-11-12T00:00:00Z");
await writeSourceChoice(db, "github", "owner@example.com", at);
assert.deepEqual(await sourcesOn(db, {}), { linear: false, github: true }, "GitHub alone turns Linear off");
assert.deepEqual((await linearSettings(db, {})).teamKeys, ["FAC"], "a row made by the choice holds the env defaults for Linear");
await writeSourceChoice(db, "both", "owner@example.com", at);
assert.deepEqual(await sourcesOn(db, {}), { linear: true, github: true });
await saveLinearSettings(db, { teamKeys: ["MOB"], label: "hive", hiveUserId: null }, "owner@example.com", at);
assert.equal(await readSourceChoice(db), "both", "saving the Linear settings keeps the choice");
assert.deepEqual((await linearSettings(db, {})).teamKeys, ["MOB"]);
await db.update(table).set({ config: { teamKeys: ["MOB"], label: "hive", hiveUserId: null, sources: "nonsense" } as never });
assert.equal(await readSourceChoice(db), "linear", "an unreadable choice is Linear alone");

const saved: unknown[] = [];
const deps = (user: SessionUser | null) => ({ user: async () => user, save: async (choice: string, by: string) => void saved.push({ choice, by }) });
const engineer = { email: "e@example.com", role: "engineer", twoFactorEnabled: true, setupDoneAt: new Date() };
const admin = { email: "owner@example.com", role: "admin", twoFactorEnabled: true, setupDoneAt: new Date() };
const refused = await saveSourceChoice(deps(engineer), "github");
assert.equal(!refused.ok && refused.status, 403, "an engineer cannot choose");
const bad = await saveSourceChoice(deps(admin), "slack");
assert.equal(!bad.ok && bad.status, 400, "only linear, github or both");
assert.deepEqual(await saveSourceChoice(deps(admin), "github"), { ok: true });
const midSetup = await saveSourceChoice(deps({ ...admin, setupDoneAt: null }), "both");
assert.deepEqual(midSetup, { ok: true }, "an admin can choose in first-run setup, before it is finished");
const noTotp = await saveSourceChoice(deps({ ...admin, twoFactorEnabled: false }), "both");
assert.equal(!noTotp.ok && noTotp.status, 403, "but not without two-factor authentication");
assert.deepEqual(
  saved,
  [
    { choice: "github", by: "owner@example.com" },
    { choice: "both", by: "owner@example.com" },
  ],
  "only an admin's valid choice is written",
);

// R14: Linear without its key, and the Linear poll when Linear is not chosen.
assert.equal(parseConfig({ ingestUrl: "https://ingest.invalid/ingest", secret: "s" }).linearApiKey, undefined, "the config loads without linearApiKey");
assert.throws(() => requireLinearKey(parseConfig({ ingestUrl: "https://ingest.invalid/ingest", secret: "s" })), /linearApiKey is not set/);
assert.equal(requireLinearKey(parseConfig({ ingestUrl: "https://ingest.invalid/ingest", secret: "s", linearApiKey: "k" })), "k");
const boom = () => {
  throw new Error("loaded");
};
assert.deepEqual(await createLinearAdapter(boom, async () => false).ready(), [], "Linear off: no key is needed and nothing is read");
await assert.rejects(createLinearAdapter(boom, async () => true).ready(), /loaded/, "Linear on: it is polled");

await db.delete(table);
console.log("job-sources regressions passed");
process.exit(0);
