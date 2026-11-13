import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "@/db/schema";
import { machines } from "@/db/schema";
import { isAdmin, type SessionUser } from "@/lib/auth/owner";

type CheckDeps = { db: NodePgDatabase<typeof schema>; user: () => Promise<SessionUser | null | undefined> };

/**
 * "Check now": nulls one machine's inventory_at. The machines trigger notifies hive_changes, and that
 * machine's runner, finding its own inventory stale, collects a fresh one (runner/heartbeat.ts checkNowWatcher).
 */
export async function checkMachineNow(deps: CheckDeps, machineId: string): Promise<{ ok: true } | { ok: false; message: string }> {
  if (!isAdmin(await deps.user())) return { ok: false, message: "Only an admin can check a machine." };
  const updated = await deps.db.update(machines).set({ inventory_at: null }).where(eq(machines.id, machineId)).returning({ id: machines.id });
  return updated.length > 0 ? { ok: true } : { ok: false, message: `No machine ${machineId}.` };
}
