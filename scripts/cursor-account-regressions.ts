import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, or } from "drizzle-orm";
import { fakeModal, sandboxes } from "./fake-modal";

// R27c/R27e: a pasted Cursor key is sealed at rest, never comes back out, reconnects in place, and only its owner disconnects it.
const { db } = await import("../db/client");
const { agentAccounts, intents, jobs, user } = await import("../db/schema");
const { connectApiKey, disconnectOwnAccount, setAccountShared } = await import("../lib/account-logins");
const { accountMeters } = await import("../lib/account-meters");
const { accountFor, newKeyPair, pickAccount, seal, unseal } = await import("../lib/creds");
const { factorySchema } = await import("../lib/config");
const { modal } = await import("../lib/modal-host");
const { createJobSandbox, cursorKey, sandboxRuntime } = await import("../runner/sandbox");
const { linearJob } = await import("./fixtures");

const pair = newKeyPair();
const KEY = "key_fake-cursor-regression-0001";
const NEW_KEY = "key_fake-cursor-regression-0002";
const users = ["cursor-me", "cursor-other"];
const own = (id: string) => db.select().from(agentAccounts).where(eq(agentAccounts.owner_id, id));
const POOL_KEY = "key_fake-cursor-regression-pool";
const leaks = (text: string) => [KEY, NEW_KEY, POOL_KEY].some((k) => text.includes(k));
const [mine, theirs] = [`CUR-ME-${Date.now()}`, `CUR-OTHER-${Date.now()}`];
const poolId = `cursor-pool-${Date.now()}`;

const clean = async () => {
  await db.delete(agentAccounts).where(or(inArray(agentAccounts.owner_id, users), eq(agentAccounts.id, poolId)));
  await db.delete(jobs).where(inArray(jobs.key, [mine, theirs]));
  await db.delete(user).where(inArray(user.id, users));
};
await clean();
try {
  await db.insert(user).values(users.map((id) => ({ id, name: id, email: `${id}@unibuz.com.au`, role: "engineer" })));
  const intentsBefore = (await db.select({ id: intents.id }).from(intents)).length;

  // Bad input and a missing public key are refused with fixed messages that never echo the key.
  for (const bad of ["", "short", `${KEY} with spaces`])
    assert.deepEqual(await connectApiKey(db, "cursor-me", bad, pair.publicKey), { ok: false, status: 400, message: "Paste the whole API key." });
  assert.deepEqual(await connectApiKey(db, "cursor-me", KEY, undefined), { ok: false, status: 500, message: "HIVE_CREDS_PUBLIC_KEY is not set." });
  assert.deepEqual(await connectApiKey(db, "cursor-me", KEY, "not a pem"), { ok: false, status: 500, message: "Could not save the key." });
  assert.equal((await own("cursor-me")).length, 0, "nothing stored for a refused key");

  // Sealed at rest: the row holds no plaintext, and the runners' private key opens it.
  assert.deepEqual(await connectApiKey(db, "cursor-me", `  ${KEY}\n`, pair.publicKey), { ok: true });
  const [row] = await own("cursor-me");
  assert.deepEqual([row!.provider, row!.kind, row!.owner_id, row!.shared], ["cursor", "api_key", "cursor-me", false]);
  assert.ok(!Buffer.from(row!.sealed).includes(KEY), "the sealed bytes hold no plaintext key");
  assert.equal(unseal(row!.sealed, pair.privateKey), KEY, "the trimmed key seals and opens");

  // The card and meter payload carries no secret.
  const meters = await accountMeters(db, { id: "cursor-me", admin: true });
  const card = meters.mine.find((a) => a.id === row!.id)!;
  assert.deepEqual([card.provider, card.kind, card.fiveHour, card.weekly], ["cursor", "api_key", null, null]);
  const json = JSON.stringify(meters);
  assert.ok(!leaks(json) && !json.includes("sealed") && !json.includes(Buffer.from(row!.sealed).toString("base64")), "no key or sealed bytes");

  // The key never leases to a Claude or Codex job; a Cursor pick finds the owner's own account first.
  assert.equal(pickAccount([row!], "cursor-me", "codex"), undefined, "a Cursor key is no Codex account");
  assert.equal(pickAccount([row!], "cursor-me", "claude"), undefined, "a Cursor key is no Claude account");

  // Another user's account id is refused, and that account is untouched.
  assert.deepEqual(await disconnectOwnAccount(db, "cursor-other", row!.id), { ok: false, status: 403, message: "You can only disconnect your own accounts." });
  assert.deepEqual(await setAccountShared(db, "cursor-other", row!.id, true), { ok: false, status: 403, message: "You can only share your own accounts." });
  const [untouched] = await own("cursor-me");
  assert.deepEqual([untouched!.disconnected_at, untouched!.shared, untouched!.sealed.length > 0], [null, false, true]);

  // Opt-in sharing (R27d) works for the key as for any own account.
  assert.deepEqual(await setAccountShared(db, "cursor-me", row!.id, true), { ok: true });

  // Reconnect replaces the key in place: same row, sharing kept.
  assert.deepEqual(await connectApiKey(db, "cursor-me", NEW_KEY, pair.publicKey), { ok: true });
  const rows = await own("cursor-me");
  assert.equal(rows.length, 1, "one Cursor account per user");
  assert.deepEqual([rows[0]!.id, rows[0]!.shared, unseal(rows[0]!.sealed, pair.privateKey)], [row!.id, true, NEW_KEY]);

  // Disconnect wipes the sealed key; connecting again revives the same row.
  assert.deepEqual(await disconnectOwnAccount(db, "cursor-me", row!.id), { ok: true });
  const [gone] = await own("cursor-me");
  assert.ok(gone!.disconnected_at, "disconnected_at is set");
  assert.equal(gone!.sealed.length, 0, "sealed is emptied");
  assert.deepEqual(await connectApiKey(db, "cursor-me", KEY, pair.publicKey), { ok: true });
  const [back] = await own("cursor-me");
  assert.deepEqual([back!.id, back!.disconnected_at, back!.shared, unseal(back!.sealed, pair.privateKey)], [row!.id, null, false, KEY]);

  // m3-09e: a sandbox job gets its owner's Cursor key, else the pool's, only as CURSOR_API_KEY; none still launches without it.
  modal.api = fakeModal;
  process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey;
  const logs: string[] = [];
  sandboxRuntime.log = (event, detail) => void logs.push(`${event} ${JSON.stringify(detail)}`);
  await db.insert(jobs).values([linearJob(mine, mine, { owner_id: "cursor-me" }), linearJob(theirs, theirs, { owner_id: "cursor-other" })]);
  const limits = factorySchema.parse({}).sandbox;
  const envOf = async (key: string) => {
    const made = { key, attempt: 1, label: "hive", machineId: "m", imageId: "im-test", limits, claudeToken: "claude-fake" };
    const { sandboxId } = await createJobSandbox({ ...made, cursorKey: await cursorKey(key) });
    return sandboxes.get(sandboxId)!.spec!.secrets;
  };
  assert.deepEqual(await envOf(mine), { CLAUDE_CODE_OAUTH_TOKEN: "claude-fake", CURSOR_API_KEY: KEY }, "the owner's own key");
  assert.deepEqual(await envOf(theirs), { CLAUDE_CODE_OAUTH_TOKEN: "claude-fake" }, "no Cursor account: the job launches without CURSOR_API_KEY");
  assert.deepEqual(await setAccountShared(db, "cursor-me", row!.id, true), { ok: true });
  assert.equal((await envOf(theirs)).CURSOR_API_KEY, KEY, "a teammate's shared key");
  await setAccountShared(db, "cursor-me", row!.id, false);
  await db
    .insert(agentAccounts)
    .values({ id: poolId, owner_id: null, provider: "cursor", kind: "api_key", label: "pool", sealed: seal(POOL_KEY, pair.publicKey) });
  assert.equal((await envOf(theirs)).CURSOR_API_KEY, POOL_KEY, "an unowned pool key");
  assert.equal((await envOf(mine)).CURSOR_API_KEY, KEY, "the owner's own key beats the pool");
  // A Claude or Codex lease never picks a Cursor key.
  for (const lead of ["claude", "codex"] as const) {
    const leased = await accountFor(mine, lead, undefined);
    assert.ok(leased === null || leased === "wait" || ![row!.id, poolId].includes(leased.id!), `no Cursor key for a ${lead} lease`);
  }
  // A key that will not open is logged in fixed text and the job launches without it.
  process.env.HIVE_CREDS_PRIVATE_KEY = newKeyPair().privateKey;
  assert.equal(await cursorKey(mine), undefined);
  assert.ok(
    logs.some((l) => l.startsWith("sandbox:no-cursor-key")),
    "the failure is logged",
  );
  process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey;
  const jobRows = JSON.stringify(
    await db
      .select()
      .from(jobs)
      .where(inArray(jobs.key, [mine, theirs])),
  );
  assert.ok(!leaks(jobRows) && !logs.some(leaks), "no key in the job rows or the logged events");

  // A pasted key writes no intent: nothing a runner logs carries it.
  const after = await db.select({ detail: intents.detail }).from(intents);
  assert.equal(after.length, intentsBefore, "connecting a key writes no intent");
  assert.ok(!after.some((i) => leaks(i.detail ?? "")), "no intent holds the key");
} finally {
  await clean();
}

console.log("cursor-account regressions pass");
process.exit(0);
