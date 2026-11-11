import { randomUUID } from "node:crypto";
import { and, eq, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../db/schema";
import { agentAccounts } from "../db/schema";
import { type MeterAccount, accountMeters } from "./account-meters";
import { isAdmin, type SessionUser } from "./auth/owner";
import { seal } from "./creds";
import type { Viewer } from "./inbox";

// R10b: admins add, rename and disconnect team pool accounts (agent_accounts, no owner). The key is sealed before Postgres; nothing here returns it or `sealed`.

type Db = NodePgDatabase<typeof schema>;
type Deps = { user: () => Promise<SessionUser | null | undefined>; db: Db; publicKey?: string; now?: () => Date };
export type PoolOutcome = { ok: true } | { ok: false; status: 400 | 403 | 404 | 500; message: string };

// Every message is custom, so a zod issue never echoes the key.
const addSchema = z.object({
  provider: z.enum(["claude", "codex"], "Pick Claude or Codex."),
  label: z.string("Name the account.").trim().min(1, "Name the account.").max(80, "Keep the name under 80 characters."),
  apiKey: z.string("Paste the API key.").trim().min(1, "Paste the API key."),
});
const renameSchema = z.object({ id: z.string("Pick an account.").min(1), label: addSchema.shape.label });

const refuse = (status: 400 | 403 | 404 | 500, message: string): PoolOutcome => ({ ok: false, status, message });
const admin = async (deps: Deps) => {
  const user = await deps.user();
  return isAdmin(user) ? user : null;
};
const FORBIDDEN = refuse(403, "Only an admin can manage the team pool.");
const livePoolAccount = (id: string) => and(eq(agentAccounts.id, id), isNull(agentAccounts.owner_id), isNull(agentAccounts.disconnected_at));

export async function addPoolAccount(deps: Deps, input: unknown): Promise<PoolOutcome> {
  const user = await admin(deps);
  if (!user) return FORBIDDEN;
  const parsed = addSchema.safeParse(input);
  if (!parsed.success) return refuse(400, parsed.error.issues[0]?.message ?? "The account is not valid.");
  if (!deps.publicKey) return refuse(500, "HIVE_CREDS_PUBLIC_KEY is not set.");
  const { provider, label, apiKey } = parsed.data;
  try {
    // Seal inside the try: a bad public key throws, and no seal or DB error text is passed on (it can carry the key).
    const sealed = seal(apiKey, deps.publicKey);
    await deps.db.insert(agentAccounts).values({ id: randomUUID(), owner_id: null, provider, kind: "api_key", label, sealed, created_by: user.id ?? null });
    return { ok: true };
  } catch {
    return refuse(500, "Could not add the pool account.");
  }
}

export async function renamePoolAccount(deps: Deps, input: unknown): Promise<PoolOutcome> {
  if (!(await admin(deps))) return FORBIDDEN;
  const parsed = renameSchema.safeParse(input);
  if (!parsed.success) return refuse(400, parsed.error.issues[0]?.message ?? "Name the account.");
  try {
    const rows = await deps.db
      .update(agentAccounts)
      .set({ label: parsed.data.label })
      .where(livePoolAccount(parsed.data.id))
      .returning({ id: agentAccounts.id });
    return rows.length ? { ok: true } : refuse(404, "No such pool account.");
  } catch {
    return refuse(500, "Could not rename the pool account.");
  }
}

// Disconnecting wipes the sealed key; add the account afresh to reconnect.
export async function disconnectPoolAccount(deps: Deps, input: unknown): Promise<PoolOutcome> {
  if (!(await admin(deps))) return FORBIDDEN;
  const parsed = renameSchema.pick({ id: true }).safeParse(input);
  if (!parsed.success) return refuse(400, parsed.error.issues[0]?.message ?? "Pick an account.");
  try {
    const rows = await deps.db
      .update(agentAccounts)
      .set({ disconnected_at: (deps.now ?? (() => new Date()))(), sealed: Buffer.alloc(0) })
      .where(livePoolAccount(parsed.data.id))
      .returning({ id: agentAccounts.id });
    return rows.length ? { ok: true } : refuse(404, "No such pool account.");
  } catch {
    return refuse(500, "Could not disconnect the pool account.");
  }
}

/** The live pool accounts, for any signed-in member (Q21). ponytail: reuses the meter query; pool rows hold no owner data. */
export async function poolAccounts(db: Db, viewer: Viewer | null): Promise<MeterAccount[]> {
  if (!viewer) return [];
  return ((await accountMeters(db, { ...viewer, admin: true })).accounts ?? []).filter((a) => a.ownerId === null);
}
