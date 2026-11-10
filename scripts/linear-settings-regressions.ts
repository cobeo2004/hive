import "./test-guard";
import assert from "node:assert/strict";
import type { SessionUser } from "../lib/auth/owner";

const { db } = await import("../db/client");
const { linearSettings: table } = await import("../db/schema");
const { linearSettings, linearWebhookInput, saveLinear, saveLinearSettings } = await import("../lib/linear-settings");
const { sourceFor } = await import("../lib/sources");

await db.delete(table);
assert.deepEqual(
  await linearSettings(db, {}),
  { teamKeys: ["FAC"], label: "hive", hiveUserId: null, saved: null },
  "with no row, FACTORY_TEAM_KEY's default FAC applies",
);
assert.deepEqual((await linearSettings(db, { FACTORY_TEAM_KEY: "ENV" })).teamKeys, ["ENV"], "with no row, FACTORY_TEAM_KEY applies");

const at = new Date("2026-11-11T00:00:00Z");
await saveLinearSettings(db, { teamKeys: ["MOB", "WEB"], label: "hive", hiveUserId: "u1" }, "owner@example.com", at);
const saved = await linearSettings(db, { FACTORY_TEAM_KEY: "ENV" });
assert.deepEqual(saved.teamKeys, ["MOB", "WEB"], "a saved row's teamKeys replace the env default");
assert.deepEqual(saved.saved, { by: "owner@example.com", at }, "the save records who and when");

const { webhook } = sourceFor("linear");
const issue = (key: string) => ({
  action: "update",
  type: "Issue",
  data: { id: "i1", identifier: `${key}-1`, team: { key }, labels: [{ id: "l1", name: "hive" }], state: { type: "unstarted", name: "Todo" } },
});
assert.equal((await webhook!.intent(issue("WEB"), {}))?.kind, "claim", "an issue from a saved team is claimed");
assert.equal(await webhook!.intent(issue("FAC"), {}), null, "an issue from a team not in teamKeys yields no intent");

const saves: unknown[] = [];
const deps = (user: SessionUser | null) => ({ user: async () => user, save: async (input: unknown, by: string) => void saves.push({ input, by }) });
const engineer = { email: "e@example.com", role: "engineer", twoFactorEnabled: true, setupDoneAt: new Date() };
const admin = { email: "owner@example.com", role: "admin", twoFactorEnabled: true, setupDoneAt: new Date() };
const input = { teamKeys: ["MOB"], label: "hive", hiveUserId: null };
const refused = await saveLinear(deps(engineer), input);
assert.equal(!refused.ok && refused.status, 403, "an engineer's save gets a 403");
for (const bad of [
  { ...input, teamKeys: [] },
  { ...input, teamKeys: ["mob"] },
  { ...input, label: " " },
]) {
  const outcome = await saveLinear(deps(admin), bad);
  assert.equal(!outcome.ok && outcome.status, 400, `rejects ${JSON.stringify(bad)}`);
}
assert.deepEqual(await saveLinear(deps(admin), input), { ok: true });
assert.deepEqual(saves, [{ input, by: "owner@example.com" }], "only the admin's valid save is written");

assert.deepEqual(
  linearWebhookInput({ url: "https://hive.example/api/webhooks/linear", secret: "s" }),
  { url: "https://hive.example/api/webhooks/linear", allPublicTeams: true, resourceTypes: ["Issue", "Comment"], secret: "s", label: "Hive intake" },
  "the install script builds one org-wide webhook",
);

await db.delete(table);
console.log("linear-settings regressions passed");
