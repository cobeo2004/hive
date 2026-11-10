import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { linearSettings, user } from "../db/schema";

type Db = Pick<NodePgDatabase<typeof schema>, "select">;

/** Who the source says is on the item: Linear's assignee and creator, by Linear user id and email. */
export type OwnerHints = {
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  creatorId?: string | null;
  creatorEmail?: string | null;
};

/**
 * The Hive user who owns a new job (R8a): the assignee if their email is a Hive user's, else the
 * creator's, else nobody. Emails match case-insensitively. Hive's own Linear user never owns a job,
 * so an issue assigned to it falls through to its creator.
 */
export async function resolveOwner(db: Db, { assigneeId, assigneeEmail, creatorId, creatorEmail }: OwnerHints): Promise<string | null> {
  const [settings] = await db.select({ config: linearSettings.config }).from(linearSettings).where(eq(linearSettings.id, "factory"));
  const hive = settings?.config.hiveUserId ?? null;
  const isHive = (id: string | null | undefined) => hive !== null && id === hive;
  for (const email of [isHive(assigneeId) ? null : assigneeEmail, isHive(creatorId) ? null : creatorEmail]) {
    if (!email) continue;
    const [found] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(sql`lower(${user.email})`, email.toLowerCase()));
    if (found) return found.id;
  }
  return null;
}
