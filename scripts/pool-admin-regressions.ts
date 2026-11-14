import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";
import type { SessionUser } from "../lib/auth/owner";

// R10b: admins add, rename and disconnect team pool accounts; the key is sealed and never comes back out.
const { db } = await import("../db/client");
const { agentAccounts, user } = await import("../db/schema");
const { newKeyPair, seal, unseal } = await import("../lib/creds");
const { addPoolAccount, disconnectPoolAccount, poolAccounts, renamePoolAccount } = await import("../lib/pool-accounts");

const pair = newKeyPair();
const KEY = "sk-ant-api03-pool-admin-fake-key";
const adminRow = "pool-admin-user";
const member = (id: string, role: "admin" | "engineer") =>
  ({ id, email: `${id}@example.com`, role, twoFactorEnabled: true, setupDoneAt: new Date() }) as SessionUser;
const [admin, engineer] = [member(adminRow, "admin"), member("pool-admin-eng", "engineer")];
const deps = (u: SessionUser, extra: { publicKey?: string } = { publicKey: pair.publicKey }) => ({ user: async () => u, db, ...extra });
const status = (o: { ok: boolean; status?: number }) => (o.ok ? 200 : o.status);
const add = { provider: "claude", label: "pool-admin key", apiKey: KEY };
const row = async (id: string) => (await db.select().from(agentAccounts).where(eq(agentAccounts.id, id)))[0]!;
const poolRows = () => db.select().from(agentAccounts).where(eq(agentAccounts.label, "pool-admin key"));
const owned = {
  id: "pool-admin-owned",
  owner_id: adminRow,
  provider: "claude",
  kind: "api_key",
  label: "pool-admin own",
  sealed: seal("sk-owned", pair.publicKey),
} as const;
const clean = async () => {
  await db.delete(agentAccounts).where(inArray(agentAccounts.label, ["pool-admin key", "pool-admin renamed", "pool-admin second", owned.label]));
  await db.delete(user).where(eq(user.id, adminRow));
};
await clean();
try {
  await db.insert(user).values({ id: adminRow, name: "Pool Admin", email: admin.email, role: "admin" });
  await db.insert(agentAccounts).values(owned);

  // Bad input and a missing public key are refused before anything is written.
  for (const bad of [{ ...add, label: " " }, { ...add, provider: "x" }, { ...add, apiKey: "  " }, null]) {
    const o = await addPoolAccount(deps(admin), bad);
    assert.equal(status(o), 400, `rejects ${JSON.stringify(bad)}`);
    assert.ok(!JSON.stringify(o).includes(KEY), "a 400 never echoes the key");
  }
  const noKey = await addPoolAccount(deps(admin, {}), add);
  assert.deepEqual(noKey, { ok: false, status: 500, message: "HIVE_CREDS_PUBLIC_KEY is not set." });
  assert.equal(status(await addPoolAccount(deps(engineer), add)), 403);
  assert.equal((await poolRows()).length, 0, "a refused add writes nothing");

  const added = await addPoolAccount(deps(admin), add);
  assert.deepEqual(added, { ok: true });
  const [created] = await poolRows();
  assert.ok(created, "the account exists");
  assert.deepEqual([created.owner_id, created.kind, created.provider, created.created_by], [null, "api_key", "claude", adminRow]);
  assert.equal(unseal(created.sealed, pair.privateKey), KEY, "the key is sealed to the public key");
  const id = created.id;

  // An engineer can rename or disconnect nothing.
  for (const act of [renamePoolAccount, disconnectPoolAccount]) assert.equal(status(await act(deps(engineer), { id, label: "pool-admin renamed" })), 403);
  assert.deepEqual(await row(id), created, "an engineer's actions change nothing");

  // Rename touches only the label.
  assert.equal(status(await renamePoolAccount(deps(admin), { id, label: "" })), 400);
  assert.deepEqual(await renamePoolAccount(deps(admin), { id, label: "  pool-admin renamed " }), { ok: true });
  assert.deepEqual(await row(id), { ...created, label: "pool-admin renamed" }, "only the label changed");

  // The owner scope: a non-pool or missing account is untouched.
  const ownedBefore = await row(owned.id);
  assert.equal(status(await renamePoolAccount(deps(admin), { id: owned.id, label: "pool-admin second" })), 404);
  assert.equal(status(await disconnectPoolAccount(deps(admin), { id: owned.id })), 404);
  assert.deepEqual(await row(owned.id), ownedBefore, "an owned account is never changed here");
  assert.equal(status(await renamePoolAccount(deps(admin), { id: "pool-admin-missing", label: "x" })), 404);

  // The list: a member sees the pool row, not the owned row.
  const asEngineer = { id: engineer.id!, admin: false };
  const listed = await poolAccounts(db, asEngineer);
  assert.equal(listed.map((a) => a.id).join(), id);
  assert.deepEqual(await poolAccounts(db, null), [], "no viewer, no list");

  // Disconnect clears the key and hides the account.
  assert.deepEqual(await disconnectPoolAccount(deps(admin), { id }), { ok: true });
  const gone = await row(id);
  assert.ok(gone.disconnected_at && gone.sealed.length === 0, "disconnected_at is set and the sealed key is wiped");
  assert.equal(status(await disconnectPoolAccount(deps(admin), { id })), 404, "disconnecting again finds nothing");
  assert.equal(status(await renamePoolAccount(deps(admin), { id, label: "pool-admin second" })), 404, "a disconnected account cannot be renamed");
  assert.deepEqual(await poolAccounts(db, asEngineer), [], "a disconnected account is not listed");

  // Nothing returned or listed carries the key or sealed data.
  const sealedText = (["base64", "hex"] as const).map((enc) => Buffer.from(created.sealed).toString(enc));
  for (const value of [added, noKey, listed, await poolAccounts(db, { id: adminRow, admin: true })]) {
    const json = JSON.stringify(value);
    for (const s of [KEY, "sealed", ...sealedText]) assert.ok(!json.includes(s), `no ${s}`);
  }
} finally {
  await clean();
}

console.log("pool-admin regressions passed");
process.exit(0);
