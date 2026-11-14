import "./test-guard";
import assert from "node:assert/strict";
import { inArray } from "drizzle-orm";

// R11c: usage meters by role, and never any sealed data.
const { db } = await import("../db/client");
const { accountUsage, agentAccounts, user } = await import("../db/schema");
const { newKeyPair, seal } = await import("../lib/creds");
const { accountMeters } = await import("../lib/account-meters");

const pair = newKeyPair();
const TOKEN = "sk-ant-oat-meters-secret-token";
const sealed = seal(TOKEN, pair.publicKey);
const METER_KEYS = ["fiveHour", "id", "kind", "label", "ownerId", "ownerName", "provider", "shared", "weekly"];
const users = ["meters-a", "meters-b", "meters-admin"];
const ids = ["m-a-claude", "m-a-codex", "m-b-claude", "m-pool-60", "m-pool-82", "m-pool-key", "m-pool-gone"];
const acct = (id: string, owner: string | null, provider: "claude" | "codex", kind: "subscription" | "api_key", label: string, disconnected = false) => ({
  id,
  owner_id: owner,
  provider,
  kind,
  label,
  sealed,
  ...(disconnected ? { disconnected_at: new Date() } : {}),
});
const reading = (id: string, pct: number, window: "5h" | "7d" = "5h") => ({
  account_id: id,
  window,
  used_pct: pct,
  resets_at: new Date("2026-11-11T09:00:00.000Z"),
  read_at: new Date("2026-11-11T06:00:00.000Z"),
});

const clean = async () => {
  await db.delete(agentAccounts).where(inArray(agentAccounts.id, ids));
  await db.delete(user).where(inArray(user.id, users));
};
await clean();
try {
  await db.insert(user).values([
    { id: "meters-a", name: "Ann", email: "meters-a@example.com", role: "engineer" },
    { id: "meters-b", name: "Bob", email: "meters-b@example.com", role: "engineer" },
    { id: "meters-admin", name: "Admin", email: "meters-admin@example.com", role: "admin" },
  ]);
  await db
    .insert(agentAccounts)
    .values([
      acct("m-a-claude", "meters-a", "claude", "subscription", "Claude Max"),
      acct("m-a-codex", "meters-a", "codex", "subscription", "Codex Plus"),
      acct("m-b-claude", "meters-b", "claude", "subscription", "Bob Claude"),
      acct("m-pool-60", null, "claude", "subscription", "Pool 60"),
      acct("m-pool-82", null, "claude", "subscription", "Pool 82"),
      acct("m-pool-key", null, "codex", "api_key", "Pool key"),
      acct("m-pool-gone", null, "claude", "subscription", "Pool gone", true),
    ]);
  await db
    .insert(accountUsage)
    .values([
      reading("m-a-claude", 62),
      reading("m-a-claude", 38, "7d"),
      reading("m-b-claude", 30),
      reading("m-pool-60", 60),
      reading("m-pool-82", 82),
      reading("m-pool-key", 5),
      reading("m-pool-gone", 99),
    ]);

  const a = await accountMeters(db, { id: "meters-a", admin: false });
  assert.deepEqual(
    a.mine.map((m) => m.id),
    ["m-a-claude", "m-a-codex"],
    "an engineer sees only their own accounts",
  );
  assert.equal(a.accounts, undefined, "an engineer gets no all-accounts list");
  assert.ok(!("accounts" in a), "the property is absent");
  assert.equal(a.pool.fiveHourPct, 71, "the pool mean counts active subscription readings only (api_key 5, disconnected 99 excluded)");
  const [claude, codex] = a.mine;
  assert.equal(claude!.fiveHour?.usedPct, 62);
  assert.equal(claude!.weekly?.usedPct, 38);
  assert.equal(claude!.ownerName, "Ann");
  assert.equal(codex!.fiveHour, null, "no reading, no meter");
  assert.equal(codex!.weekly, null);

  const admin = await accountMeters(db, { id: "meters-admin", admin: true });
  assert.deepEqual(
    admin.accounts!.map((m) => m.id).sort(),
    ["m-a-claude", "m-a-codex", "m-b-claude", "m-pool-60", "m-pool-82", "m-pool-key"],
    "every active account",
  );
  const b = admin.accounts!.find((m) => m.id === "m-b-claude")!;
  assert.deepEqual([b.label, b.ownerId, b.ownerName], ["Bob Claude", "meters-b", "Bob"]);
  const pool = admin.accounts!.find((m) => m.id === "m-pool-60")!;
  assert.deepEqual([pool.ownerId, pool.ownerName], [null, null], "a pool account has no owner");
  assert.equal(admin.accounts!.find((m) => m.id === "m-pool-key")!.fiveHour, null);
  assert.deepEqual(admin.mine, [], "an admin owns none of these");

  for (const result of [a, admin]) {
    const json = JSON.stringify(result);
    assert.ok(!json.includes("sealed"), "no sealed key");
    assert.ok(!json.includes(TOKEN), "no token text");
    assert.ok(!json.includes(Buffer.from(sealed).toString("base64")), "no sealed bytes");
    assert.ok(!json.includes('"Buffer"'), "no serialized Buffer");
    for (const m of [...result.mine, ...(result.accounts ?? [])]) assert.deepEqual(Object.keys(m).sort(), METER_KEYS, "only the documented MeterAccount keys");
  }

  assert.deepEqual(await accountMeters(db, null), { mine: [], pool: { fiveHourPct: null } }, "no viewer, nothing");
} finally {
  await clean();
}

console.log("account-meters regressions pass");
process.exit(0);
