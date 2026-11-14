import "./test-guard";
import assert from "node:assert/strict";
import { eq, inArray, sql } from "drizzle-orm";

// R4, R32: Settings → Members. Admins only; the last admin can't be demoted; invites are for @example.com.
const { db } = await import("../db/client");
const { accessLinks, user } = await import("../db/schema");
const members = await import("../lib/members");

const ADMIN = "members-admin@example.com";
const ENG = "members-eng@example.com";
const ids = { admin: "members-admin", eng: "members-eng" };
const as = (email: string, role: string, id: string) => ({ user: async () => ({ id, email, role, twoFactorEnabled: true, setupDoneAt: new Date() }) });
const admin = as(ADMIN, "admin", ids.admin);
const engineer = as(ENG, "engineer", ids.eng);
const roleOf = async (id: string) => (await db.select({ role: user.role }).from(user).where(eq(user.id, id)))[0]!.role;

async function reset() {
  await db.execute(sql`delete from access_links`);
  await db.delete(user).where(inArray(user.id, [ids.admin, ids.eng]));
  await db.delete(user).where(eq(user.role, "admin"));
}
await reset();
await db.insert(user).values([
  { id: ids.admin, name: "Admin", email: ADMIN, role: "admin", twoFactorEnabled: true, setupDoneAt: new Date() },
  { id: ids.eng, name: "Eng", email: ENG, role: "engineer", twoFactorEnabled: true, setupDoneAt: new Date() },
]);
try {
  // An engineer calling any Members action directly gets 403.
  const refused = { ok: false, status: 403, message: members.ADMIN_ONLY };
  assert.deepEqual(await members.listMembers(engineer), refused, "an engineer can't list members");
  assert.deepEqual(await members.setMemberRole(engineer, ids.eng, "admin"), refused, "an engineer can't promote themselves");
  assert.deepEqual(await members.createInvite(engineer, "new@example.com"), refused, "an engineer can't invite");
  assert.deepEqual(await members.createMemberResetLink(engineer, ADMIN), refused, "an engineer can't make reset links");
  assert.deepEqual(
    await members.listMembers({ user: async () => ({ email: ADMIN, role: "admin", twoFactorEnabled: false }) }),
    refused,
    "an admin without TOTP is refused",
  );
  assert.equal(await roleOf(ids.eng), "engineer");
  assert.equal((await db.select().from(accessLinks)).length, 0, "no link was made");

  const listed = await members.listMembers(admin);
  assert.ok(listed.ok);
  assert.deepEqual(
    listed.members.map((m) => [m.email, m.role]),
    [
      [ADMIN, "admin"],
      [ENG, "engineer"],
    ],
  );

  // The last admin can't be demoted.
  assert.deepEqual(await members.setMemberRole(admin, ids.admin, "engineer"), { ok: false, status: 400, message: members.LAST_ADMIN });
  assert.equal(await roleOf(ids.admin), "admin");
  assert.equal((await members.setMemberRole(admin, ids.admin, "owner" as "admin")).ok, false, "only admin or engineer");

  // With two admins, demoting each other at once leaves exactly one.
  assert.deepEqual(await members.setMemberRole(admin, ids.eng, "admin"), { ok: true });
  const raced = await Promise.all([members.setMemberRole(admin, ids.eng, "engineer"), members.setMemberRole(as(ENG, "admin", ids.eng), ids.admin, "engineer")]);
  assert.equal(raced.filter((r) => r.ok).length, 1, "one demotion wins");
  assert.equal(Number((await db.execute<{ n: string }>(sql`select count(*) as n from "user" where role = 'admin'`)).rows[0]!.n), 1, "one admin is left");
  await db.update(user).set({ role: "admin" }).where(eq(user.id, ids.admin));
  await db.update(user).set({ role: "engineer" }).where(eq(user.id, ids.eng));

  // Invites: any email, never for an existing account; the link is copyable and lasts 7 days.
  assert.ok((await members.createInvite(admin, "someone@gmail.com")).ok, "an invite works for any email domain");
  assert.equal((await members.createInvite(admin, ENG)).ok, false, "an existing member is not invited again");
  const invite = await members.createInvite(admin, "New@Example.com");
  assert.ok(invite.ok);
  assert.match(invite.url, /\/auth\/accept\?token=[\w-]{40,}$/);
  const [link] = await db.select().from(accessLinks).where(eq(accessLinks.email, "new@example.com"));
  assert.deepEqual([link!.kind, link!.email, link!.created_by], ["invite", "new@example.com", ids.admin]);
  assert.ok(Math.abs(link!.expires_at.getTime() - Date.now() - 7 * 24 * 3_600_000) < 60_000, "valid 7 days");

  // Reset links: only for an existing member.
  assert.equal((await members.createMemberResetLink(admin, "ghost@example.com")).ok, false);
  const resetLink = await members.createMemberResetLink(admin, ENG);
  assert.ok(resetLink.ok);
  assert.match(resetLink.url, /\/auth\/reset\?token=/);
} finally {
  await reset();
}
console.log("members regressions passed");
process.exit(0);
