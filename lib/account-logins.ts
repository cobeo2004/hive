import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";

// The panel's half of connecting an account (R9b): the login row and the intent that tells a runner to run the login. It never sees a token.

type Db = NodePgDatabase<typeof schema>;
const { accountLogins, intents } = schema;

export const LOGIN_TTL_MS = 10 * 60_000;

const intent = (detail: object, at: Date) => ({
  id: `panel:account_login:${randomUUID()}`,
  kind: "account_login" as const,
  detail: JSON.stringify(detail),
  created_at: at,
});

/** Starts a login for the user; one already running for that provider is replaced. Returns its id. */
export async function writeLogin(database: Db, userId: string, provider: "claude" | "codex", at = new Date()) {
  const id = randomUUID();
  await database.transaction(async (tx) => {
    await tx.delete(accountLogins).where(and(eq(accountLogins.user_id, userId), eq(accountLogins.provider, provider)));
    await tx.insert(accountLogins).values({ id, user_id: userId, provider, expires_at: new Date(at.getTime() + LOGIN_TTL_MS), created_at: at });
    await tx.insert(intents).values(intent({ loginId: id }, at));
  });
  return id;
}

/** Hands the code a user pasted back to the runner, through an intent. Only the login's own user, while it waits for one. */
export async function writeCode(database: Db, userId: string, loginId: string, code: string, at = new Date()) {
  const [login] = await database.select().from(accountLogins).where(eq(accountLogins.id, loginId));
  const waiting = login?.user_id === userId && login.provider === "claude" && login.status === "waiting_code" && login.expires_at > at;
  if (!waiting || !code.trim()) return false;
  await database.insert(intents).values(intent({ loginId, code: code.trim() }, at));
  return true;
}

export const cancelLogin = (database: Db, userId: string, loginId: string) =>
  database.delete(accountLogins).where(and(eq(accountLogins.id, loginId), eq(accountLogins.user_id, userId)));

export const readLogin = (database: Db, userId: string, loginId: string) =>
  database
    .select()
    .from(accountLogins)
    .where(and(eq(accountLogins.id, loginId), eq(accountLogins.user_id, userId)))
    .then(([login]) => login ?? null);
