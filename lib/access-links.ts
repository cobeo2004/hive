import { createHash, randomBytes, randomUUID } from "node:crypto";
import { and, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db/client";
import { accessLinks, user } from "@/db/schema";
import { auth } from "@/lib/auth/server";

// One-time setup, invite and reset links (R32). Only a token's sha256 is stored; the raw token is the link.

export type LinkKind = "setup" | "invite" | "reset";

export const INVITE_DOMAIN = "@unibuz.com.au";
export const INVALID_LINK = "This link is invalid or used.";
export const SETUP_BUSY = "Another setup is in progress. Try again in a moment.";
export const ADMIN_EXISTS = "An admin already exists, so setup links are closed.";
export const SETUP_TTL_MS = 60 * 60 * 1000;
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const RESET_TTL_MS = 24 * 60 * 60 * 1000;
export const MIN_PASSWORD = 8;
// Any fixed key: every setup acceptance takes it, so two different setup tokens can't both make an admin.
const SETUP_LOCK = 7_342_001;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
const hash = (token: string) => createHash("sha256").update(token).digest("hex");
const normal = (email: string) => email.trim().toLowerCase();

async function adminExists(tx: Tx | typeof db = db) {
  const [row] = await tx.select({ id: user.id }).from(user).where(eq(user.role, "admin")).limit(1);
  return !!row;
}

export async function createLink(kind: LinkKind, email: string | null, ttlMs: number, createdBy: string | null = null) {
  const bound = email === null ? null : normal(email);
  if (kind === "invite" && !bound?.endsWith(INVITE_DOMAIN)) throw new Error(`Invites are for ${INVITE_DOMAIN} emails only.`);
  if (kind !== "setup" && !bound) throw new Error("A link needs an email.");
  if (kind === "setup" && (await adminExists())) throw new Error(ADMIN_EXISTS);
  const token = randomBytes(32).toString("base64url");
  await db.insert(accessLinks).values({
    id: randomUUID(),
    kind,
    token_hash: hash(token),
    email: bound,
    expires_at: new Date(Date.now() + ttlMs),
    created_by: createdBy,
  });
  return token;
}

/** The link's email if it is unused and unexpired, without using it: what /auth/{setup,accept,reset} show. */
export async function peekLink(kind: LinkKind, token: string) {
  const [link] = await db
    .select({ email: accessLinks.email })
    .from(accessLinks)
    .where(and(eq(accessLinks.token_hash, hash(token)), eq(accessLinks.kind, kind), isNull(accessLinks.used_at), gt(accessLinks.expires_at, new Date())));
  if (!link || (kind === "setup" && (await adminExists()))) return null;
  return { email: link.email };
}

/** Marks the link used, once: the row lock makes a concurrent second consume see it used. */
export async function consumeLink(kind: LinkKind, token: string) {
  return db.transaction(async (tx) => {
    const [link] = await tx.select().from(accessLinks).where(eq(accessLinks.token_hash, hash(token))).for("update");
    if (!link || link.kind !== kind || link.used_at || link.expires_at <= new Date()) throw new Error(INVALID_LINK);
    if (kind === "setup" && (await adminExists(tx))) throw new Error(ADMIN_EXISTS);
    await tx.update(accessLinks).set({ used_at: new Date() }).where(eq(accessLinks.id, link.id));
    return { id: link.id, email: link.email };
  });
}

const release = (id: string) => db.update(accessLinks).set({ used_at: null }).where(eq(accessLinks.id, id));

function checkPassword(password: string) {
  if (password.length < MIN_PASSWORD) throw new Error(`Use at least ${MIN_PASSWORD} characters.`);
}

async function createUser(input: { name: string; email: string; password: string }, role: "admin" | "engineer") {
  // No headers: a server-side call, which the admin plugin allows without an admin session.
  const { user: created } = await auth.api.createUser({
    body: { name: input.name.trim() || input.email, email: input.email, password: input.password, role: role as "admin" },
  });
  return { id: created.id };
}

/** Uses the link, then creates the user; a failed create releases the link for another try. */
async function accept(kind: LinkKind, token: string, make: (email: string | null) => Promise<{ id: string }>) {
  const link = await consumeLink(kind, token);
  try {
    return await make(link.email);
  } catch (error) {
    await release(link.id);
    throw error;
  }
}

/**
 * The first admin (R32). One advisory lock admits one setup acceptance at a time, so only one admin is ever made
 * this way. It is tried, never waited for: a waiter would hold a pooled connection the lock holder may need.
 */
export async function acceptSetup(token: string, input: { name: string; email: string; password: string }) {
  checkPassword(input.password);
  if (!(await peekLink("setup", token))) throw new Error(INVALID_LINK);
  const client = await db.$client.connect();
  let locked = false;
  try {
    locked = (await client.query<{ locked: boolean }>("select pg_try_advisory_lock($1) as locked", [SETUP_LOCK])).rows[0]!.locked;
    if (!locked) throw new Error(SETUP_BUSY);
    if (await adminExists()) throw new Error(ADMIN_EXISTS);
    return await accept("setup", token, () => createUser({ ...input, email: normal(input.email) }, "admin"));
  } finally {
    if (locked) await client.query("select pg_advisory_unlock($1)", [SETUP_LOCK]).catch(() => {});
    client.release();
  }
}

/** An engineer with the invited email (R4, R32). */
export async function acceptInvite(token: string, input: { name: string; password: string }) {
  checkPassword(input.password);
  return accept("invite", token, (email) => createUser({ ...input, email: email! }, "engineer"));
}

/** Sets a new password and signs the user out everywhere; it never signs anyone in. */
export async function acceptReset(token: string, input: { password: string }) {
  checkPassword(input.password);
  const context = await auth.$context;
  return accept("reset", token, async (email) => {
    const found = await context.internalAdapter.findUserByEmail(email!);
    if (!found) throw new Error(INVALID_LINK);
    const hashed = await context.password.hash(input.password);
    // auth.api.setUserPassword needs an admin session, which a reset link's holder doesn't have.
    if (await context.internalAdapter.findCredentialAccount(found.user.id)) await context.internalAdapter.updatePassword(found.user.id, hashed);
    else await context.internalAdapter.linkAccount({ providerId: "credential", accountId: found.user.id, userId: found.user.id, password: hashed });
    await context.internalAdapter.deleteUserSessions(found.user.id);
    return { id: found.user.id };
  });
}

/** A reset link for an existing user (scripts/setup-token.ts --reset, Settings → Members). */
export async function createResetLink(email: string, createdBy: string | null = null) {
  const [found] = await db.select({ id: user.id }).from(user).where(eq(user.email, normal(email)));
  if (!found) throw new Error(`No Hive user has the email ${normal(email)}.`);
  return createLink("reset", email, RESET_TTL_MS, createdBy);
}
