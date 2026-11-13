import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import * as schema from "../db/schema";
import { seal } from "./creds";

// The panel's half of connecting an account (R9b): the login row and the intent that tells a runner to run the login. It never sees a
// subscription token; a pasted Cursor key is sealed on arrival and never read back (R27c).

type Db = NodePgDatabase<typeof schema>;
const { accountLogins, agentAccounts, intents } = schema;

const LOGIN_TTL_MS = 10 * 60_000;

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

/** An authorization code is URL-safe text (letters, digits, and `-._~#%+/=`), and short. */
const CODE = /^[\w.~#%+/=-]{1,512}$/;

/** Hands the code a user pasted back to the runner, through an intent. Only the login's own user, while it waits for one. */
export async function writeCode(database: Db, userId: string, loginId: string, code: string, at = new Date()) {
  const [login] = await database.select().from(accountLogins).where(eq(accountLogins.id, loginId));
  const waiting = login?.user_id === userId && login.provider === "claude" && login.status === "waiting_code" && login.expires_at > at;
  if (!waiting || !CODE.test(code.trim())) return false;
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

type LoginRow = Awaited<ReturnType<typeof readLogin>>;
/** What the card may show. A Claude row's code is the one the user pasted back, so only Codex's device code goes to the browser. */
export const loginForCard = (login: LoginRow) => login && { status: login.status, url: login.url, code: login.provider === "codex" ? login.code : null };

/** Disconnects the user's own account (R27, Q21): the sealed token is wiped. Anyone else's account, or a pool one, is 403. */
export async function disconnectOwnAccount(database: Db, userId: string, accountId: string, at = new Date()) {
  const rows = await database
    .update(agentAccounts)
    .set({ disconnected_at: at, sealed: Buffer.alloc(0) })
    .where(and(eq(agentAccounts.id, accountId), eq(agentAccounts.owner_id, userId)))
    .returning({ id: agentAccounts.id });
  return rows.length ? ({ ok: true } as const) : ({ ok: false, status: 403, message: "You can only disconnect your own accounts." } as const);
}

/** Opt your own account in or out of the team pool (R27d). Anyone else's id, or one that does not exist, gets the same 403. Opting out stops new leases; a run already on it keeps it. */
export async function setAccountShared(database: Db, userId: string, accountId: string, shared: boolean) {
  const rows = await database
    .update(agentAccounts)
    .set({ shared })
    .where(and(eq(agentAccounts.id, accountId), eq(agentAccounts.owner_id, userId)))
    .returning({ id: agentAccounts.id });
  return rows.length ? ({ ok: true } as const) : ({ ok: false, status: 403, message: "You can only share your own accounts." } as const);
}

/** A Cursor API key: printable, no spaces, and short. */
const API_KEY = /^[\x21-\x7e]{8,512}$/;

/**
 * Connects or replaces the user's own Cursor account (R27c): the pasted key is sealed to the runners' key and only the sealed
 * bytes are stored. A reconnect reseals the same row, so its id and sharing stay. No outcome carries the key or a library error.
 */
export async function connectApiKey(database: Db, userId: string, apiKey: string, publicKey: string | undefined) {
  const key = String(apiKey).trim();
  if (!API_KEY.test(key)) return { ok: false, status: 400, message: "Paste the whole API key." } as const;
  if (!publicKey) return { ok: false, status: 500, message: "HIVE_CREDS_PUBLIC_KEY is not set." } as const;
  try {
    const sealed = seal(key, publicKey);
    const own = and(eq(agentAccounts.owner_id, userId), eq(agentAccounts.provider, "cursor"), eq(agentAccounts.kind, "api_key"));
    const [existing] = await database.select({ id: agentAccounts.id }).from(agentAccounts).where(own).limit(1);
    if (existing) await database.update(agentAccounts).set({ sealed, disconnected_at: null }).where(eq(agentAccounts.id, existing.id));
    else
      await database
        .insert(agentAccounts)
        .values({ id: randomUUID(), owner_id: userId, provider: "cursor", kind: "api_key", label: "Cursor API key", sealed, created_by: userId });
    return { ok: true } as const;
  } catch {
    return { ok: false, status: 500, message: "Could not save the key." } as const;
  }
}
