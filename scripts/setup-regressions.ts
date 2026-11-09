import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

// R33: finishing /setup needs TOTP on, and marks only the signed-in user's own row.
const { db } = await import("../db/client");
const { user } = await import("../db/schema");
const { finishSetup } = await import("../lib/members");

const ME = "setup-me@unibuz.com.au";
const OTHER = "setup-other@unibuz.com.au";
const row = (email: string, twoFactorEnabled: boolean) => ({ id: `setup-${email}`, name: email, email, role: "engineer", twoFactorEnabled });
const doneAt = async (email: string) => (await db.select({ at: user.setupDoneAt }).from(user).where(eq(user.email, email)))[0]!.at;
const as = (email: string, twoFactorEnabled: boolean) => ({ user: async () => ({ email, role: "engineer", twoFactorEnabled }) });

await db.delete(user).where(inArray(user.email, [ME, OTHER]));
await db.insert(user).values([row(ME, false), row(OTHER, true)]);
try {
  assert.deepEqual(await finishSetup({ user: async () => null }), { ok: false, status: 403, message: "Sign in to Hive first." });
  assert.deepEqual(await finishSetup(as(ME, false)), { ok: false, status: 400, message: "Turn on two-factor authentication first." }, "refused until TOTP is on");
  assert.equal(await doneAt(ME), null);

  // A session claiming TOTP while the row says otherwise changes nothing.
  await finishSetup(as(ME, true));
  assert.equal(await doneAt(ME), null, "the row's own TOTP flag is checked");

  await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.email, ME));
  assert.deepEqual(await finishSetup(as(ME, true)), { ok: true });
  assert.ok(await doneAt(ME), "setup_done_at is set for the signed-in user");
  assert.equal(await doneAt(OTHER), null, "and for no one else");
} finally {
  await db.delete(user).where(inArray(user.email, [ME, OTHER]));
}
console.log("setup regressions passed");
process.exit(0);
