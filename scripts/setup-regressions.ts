import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray } from "drizzle-orm";

// R33: finishing /setup needs TOTP on, and marks only the signed-in user's own row.
// R28: the Linear step sits between Account and Done and saves only the signed-in user's opt-ins.
const { db } = await import("../db/client");
const { user, linearOptIns } = await import("../db/schema");
const { finishSetup } = await import("../lib/members");
const { SETUP_STEPS, saveOptIns, readOptIns, linearMatch, linearCardNote, linearUsers } = await import("../lib/opt-ins");

const ME = "setup-me@unibuz.com.au";
const OTHER = "setup-other@unibuz.com.au";
const row = (email: string, twoFactorEnabled: boolean) => ({ id: `setup-${email}`, name: email, email, role: "engineer", twoFactorEnabled });
const doneAt = async (email: string) => (await db.select({ at: user.setupDoneAt }).from(user).where(eq(user.email, email)))[0]!.at;
const as = (email: string, twoFactorEnabled: boolean) => ({ user: async () => ({ email, role: "engineer", twoFactorEnabled }) });

await db.delete(user).where(inArray(user.email, [ME, OTHER]));
await db.insert(user).values([row(ME, false), row(OTHER, true)]);
try {
  assert.deepEqual(await finishSetup({ user: async () => null }), { ok: false, status: 403, message: "Sign in to Hive first." });
  assert.deepEqual(
    await finishSetup(as(ME, false)),
    { ok: false, status: 400, message: "Turn on two-factor authentication first." },
    "refused until TOTP is on",
  );
  assert.equal(await doneAt(ME), null);

  // A session claiming TOTP while the row says otherwise changes nothing.
  await finishSetup(as(ME, true));
  assert.equal(await doneAt(ME), null, "the row's own TOTP flag is checked");

  await db.update(user).set({ twoFactorEnabled: true }).where(eq(user.email, ME));
  assert.deepEqual(await finishSetup(as(ME, true)), { ok: true });
  assert.ok(await doneAt(ME), "setup_done_at is set for the signed-in user");
  assert.equal(await doneAt(OTHER), null, "and for no one else");

  // R28: Account → Linear → Done.
  assert.deepEqual([...SETUP_STEPS], ["Account", "Linear", "Done"]);

  const optInRows = (email: string) =>
    db
      .select()
      .from(linearOptIns)
      .where(eq(linearOptIns.user_id, `setup-${email}`));
  const values = (rows: { assigned: boolean; plan_approval: boolean }[]) => rows.map(({ assigned, plan_approval }) => ({ assigned, plan_approval }));
  assert.deepEqual(await readOptIns(as(ME, true)), { assigned: false, plan_approval: false }, "off by default");
  assert.deepEqual(await saveOptIns(as(ME, true), { assigned: true, plan_approval: false }), { ok: true, optIns: { assigned: true, plan_approval: false } });
  assert.deepEqual(values(await optInRows(ME)), [{ assigned: true, plan_approval: false }], "one row for the signed-in user");
  await saveOptIns(as(ME, true), { assigned: false, plan_approval: true });
  assert.deepEqual(values(await optInRows(ME)), [{ assigned: false, plan_approval: true }], "saving again updates the same row");
  assert.deepEqual(await readOptIns(as(ME, true)), { assigned: false, plan_approval: true });

  // No one writes another user's row, whatever the input says.
  await saveOptIns(as(OTHER, true), { assigned: true, plan_approval: true });
  await saveOptIns(as(ME, true), { assigned: false, plan_approval: false, user_id: `setup-${OTHER}` });
  assert.deepEqual(values(await optInRows(OTHER)), [{ assigned: true, plan_approval: true }], "OTHER's row is unchanged");
  assert.deepEqual(values(await optInRows(ME)), [{ assigned: false, plan_approval: false }]);
  assert.deepEqual(await saveOptIns({ user: async () => null }, { assigned: true, plan_approval: true }), {
    ok: false,
    status: 403,
    message: "Sign in to Hive first.",
  });
  assert.equal((await saveOptIns(as(ME, true), { assigned: "yes", plan_approval: false })).ok, false, "non-boolean input is refused");
  assert.equal((await saveOptIns(as(ME, true), null)).ok, false);

  // The Linear card, with a fake client.
  assert.equal(linearCardNote(await linearMatch(ME, { userByEmail: async () => ({ id: "lin-1" }) }), ME), "Matched by email");
  assert.equal(linearCardNote(await linearMatch(ME, { userByEmail: async () => null }), ME), `No Linear user with ${ME}`);
  assert.equal(
    linearCardNote(
      await linearMatch(ME, {
        userByEmail: async () => {
          throw new Error("outage");
        },
      }),
      ME,
    ),
    `No Linear user with ${ME}`,
    "an outage only shows the no-match note",
  );
  assert.equal(linearCardNote(await linearMatch(ME, null), ME), "Linear isn't connected yet");
  const key = process.env.LINEAR_API_KEY;
  delete process.env.LINEAR_API_KEY;
  assert.equal(linearUsers(), null, "no key, no client");
  if (key !== undefined) process.env.LINEAR_API_KEY = key;
} finally {
  await db.delete(user).where(inArray(user.email, [ME, OTHER]));
}
console.log("setup regressions passed");
process.exit(0);
