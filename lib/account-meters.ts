import { asc, eq, inArray, isNull } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { accountUsage, agentAccounts, user } from "../db/schema";
import type { Viewer } from "./inbox";

type Db = Pick<NodePgDatabase<typeof schema>, "select">;

export type Reading = { usedPct: number; resetsAt: Date | null; readAt: Date };
export type MeterAccount = {
  id: string;
  provider: "claude" | "codex";
  kind: "subscription" | "api_key";
  label: string;
  /** Null for a team pool account. */
  ownerId: string | null;
  ownerName: string | null;
  fiveHour: Reading | null;
  weekly: Reading | null;
};
export type AccountMeters = {
  mine: MeterAccount[];
  /** Mean 5h use of the active pool subscription accounts that have a reading; null when none. */
  pool: { fiveHourPct: number | null };
  /** Admin only: every active account. Absent for an engineer. */
  accounts?: MeterAccount[];
};

/**
 * Usage meters by role (R11c). Names columns of agent_accounts one by one so `sealed` never leaves
 * the database through here.
 */
export async function accountMeters(db: Db, viewer: Viewer | null): Promise<AccountMeters> {
  if (!viewer) return { mine: [], pool: { fiveHourPct: null } };
  const rows = await db
    .select({
      id: agentAccounts.id,
      provider: agentAccounts.provider,
      kind: agentAccounts.kind,
      label: agentAccounts.label,
      ownerId: agentAccounts.owner_id,
      ownerName: user.name,
      ownerEmail: user.email,
    })
    .from(agentAccounts)
    .leftJoin(user, eq(user.id, agentAccounts.owner_id))
    .where(isNull(agentAccounts.disconnected_at))
    .orderBy(asc(agentAccounts.label), asc(agentAccounts.id));
  const usage = rows.length
    ? await db
        .select()
        .from(accountUsage)
        .where(
          inArray(
            accountUsage.account_id,
            rows.map((r) => r.id),
          ),
        )
    : [];
  const read = (id: string, window: "5h" | "7d"): Reading | null => {
    const u = usage.find((x) => x.account_id === id && x.window === window);
    return u ? { usedPct: u.used_pct, resetsAt: u.resets_at, readAt: u.read_at } : null;
  };
  const accounts: MeterAccount[] = rows.map(({ ownerName, ownerEmail, ...r }) => ({
    ...r,
    ownerName: r.ownerId === null ? null : ownerName || ownerEmail,
    fiveHour: r.kind === "subscription" ? read(r.id, "5h") : null,
    weekly: r.kind === "subscription" ? read(r.id, "7d") : null,
  }));
  const pooled = accounts.flatMap((a) => (a.ownerId === null && a.fiveHour ? [a.fiveHour.usedPct] : []));
  const result: AccountMeters = {
    mine: accounts.filter((a) => a.ownerId === viewer.id),
    pool: { fiveHourPct: pooled.length ? pooled.reduce((s, p) => s + p, 0) / pooled.length : null },
  };
  if (viewer.admin) result.accounts = accounts;
  return result;
}
