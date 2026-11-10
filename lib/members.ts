import { and, asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { user } from "@/db/schema";
import { createLink, createResetLink, INVITE_TTL_MS } from "@/lib/access-links";
import { isAdmin, isMember, type SessionUser } from "@/lib/auth/owner";
import { panelUrl } from "@/lib/slack";

// Settings → Members (R4, R32) and finishing first-run setup (R33). Admin checks are here, not in the UI.

export type MembersDeps = { user: () => Promise<SessionUser | null | undefined> };
export type Role = "admin" | "engineer";
export type Member = { id: string; name: string; email: string; role: Role; twoFactorEnabled: boolean; setupDone: boolean };
type Refused = { ok: false; status: 400 | 403; message: string };

export const ADMIN_ONLY = "Only an admin can manage members.";
export const LAST_ADMIN = "The last admin can't be demoted.";
const forbidden: Refused = { ok: false, status: 403, message: ADMIN_ONLY };
const failed = (error: unknown): Refused => ({ ok: false, status: 400, message: error instanceof Error ? error.message : String(error) });

export async function listMembers(deps: MembersDeps): Promise<{ ok: true; members: Member[] } | Refused> {
  if (!isAdmin(await deps.user())) return forbidden;
  const rows = await db.select().from(user).orderBy(asc(user.name), asc(user.email));
  return {
    ok: true,
    members: rows.map((row) => ({
      id: row.id,
      name: row.name,
      email: row.email,
      role: row.role === "admin" ? "admin" : "engineer",
      twoFactorEnabled: row.twoFactorEnabled === true,
      setupDone: !!row.setupDoneAt,
    })),
  };
}

export async function setMemberRole(deps: MembersDeps, userId: string, role: Role): Promise<{ ok: true } | Refused> {
  if (!isAdmin(await deps.user())) return forbidden;
  if (role !== "admin" && role !== "engineer") return { ok: false, status: 400, message: "A role is admin or engineer." };
  return db.transaction(async (tx) => {
    // Locking every admin row serialises concurrent demotions, so two admins can't demote each other to none.
    const admins = await tx.select({ id: user.id }).from(user).where(eq(user.role, "admin")).for("update");
    if (role === "engineer" && admins.length === 1 && admins[0]!.id === userId) return { ok: false, status: 400, message: LAST_ADMIN } as const;
    const updated = await tx.update(user).set({ role, updatedAt: new Date() }).where(eq(user.id, userId)).returning({ id: user.id });
    return updated.length ? ({ ok: true } as const) : ({ ok: false, status: 400, message: "No such member." } as const);
  });
}

/** The member with this email, as the inbox actions check them; null when none has TOTP on and setup finished (R6). */
export async function memberByEmail(email: string | null): Promise<SessionUser | null> {
  if (!email) return null;
  const [row] = await db.select().from(user).where(eq(user.email, email.trim().toLowerCase()));
  if (!row) return null;
  const found = { id: row.id, email: row.email, name: row.name, role: row.role, twoFactorEnabled: row.twoFactorEnabled, setupDoneAt: row.setupDoneAt };
  return isMember(found) ? found : null;
}

/** A copyable invite link for one @unibuz.com.au email, valid 7 days; Hive never emails it. */
export async function createInvite(deps: MembersDeps, email: string): Promise<{ ok: true; url: string; expiresAt: Date } | Refused> {
  const actor = await deps.user();
  if (!isAdmin(actor)) return forbidden;
  const [taken] = await db.select({ id: user.id }).from(user).where(eq(user.email, email.trim().toLowerCase()));
  if (taken) return { ok: false, status: 400, message: "That email already has a Hive account." };
  try {
    const token = await createLink("invite", email, INVITE_TTL_MS, actor.id ?? null);
    return { ok: true, url: `${panelUrl()}/auth/accept?token=${token}`, expiresAt: new Date(Date.now() + INVITE_TTL_MS) };
  } catch (error) {
    return failed(error);
  }
}

/** A copyable password-reset link for an existing member. */
export async function createMemberResetLink(deps: MembersDeps, email: string): Promise<{ ok: true; url: string } | Refused> {
  const actor = await deps.user();
  if (!isAdmin(actor)) return forbidden;
  try {
    return { ok: true, url: `${panelUrl()}/auth/reset?token=${await createResetLink(email, actor.id ?? null)}` };
  } catch (error) {
    return failed(error);
  }
}

/** Saves the signed-in user's own name (R5); trimmed, 1 to 80 characters, and no one else's row. */
export async function saveOwnName(deps: MembersDeps, name: string): Promise<{ ok: true; name: string } | Refused> {
  const actor = await deps.user();
  if (!actor) return { ok: false, status: 403, message: "Sign in to Hive first." };
  const trimmed = name.trim();
  if (trimmed.length < 1 || trimmed.length > 80) return { ok: false, status: 400, message: "A name is 1 to 80 characters." };
  const updated = await db.update(user).set({ name: trimmed, updatedAt: new Date() }).where(eq(user.email, actor.email)).returning({ id: user.id });
  if (updated.length === 0) return { ok: false, status: 400, message: "No such member." };
  return { ok: true, name: trimmed };
}

/** Ends /setup for the signed-in user once TOTP is on (R33). */
export async function finishSetup(deps: MembersDeps): Promise<{ ok: true } | Refused> {
  const actor = await deps.user();
  if (!actor) return { ok: false, status: 403, message: "Sign in to Hive first." };
  // Not isMember: that needs setup done, which is what this sets.
  if (actor.twoFactorEnabled !== true) return { ok: false, status: 400, message: "Turn on two-factor authentication first." };
  await db
    .update(user)
    .set({ setupDoneAt: new Date() })
    .where(and(eq(user.email, actor.email), eq(user.twoFactorEnabled, true)));
  return { ok: true };
}
