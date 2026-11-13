import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { linearSettings, user } from "../db/schema";

type Db = Pick<NodePgDatabase<typeof schema>, "select">;

/** Who the source says is on the item: assignee and creator, by Linear user id and email, or by GitHub user id (R27f). */
export type OwnerHints = {
  assigneeId?: string | null;
  assigneeEmail?: string | null;
  assigneeGithubId?: number | null;
  creatorId?: string | null;
  creatorEmail?: string | null;
  creatorGithubId?: number | null;
};

/**
 * The Hive user who owns a new job (R8a): the assignee if their linked GitHub id (R27f) or email is a Hive user's, else the
 * creator's, else nobody. Emails match case-insensitively. Hive's own Linear user never owns a job,
 * so an issue assigned to it falls through to its creator.
 */
export async function resolveOwner(db: Db, hints: OwnerHints): Promise<string | null> {
  const { assigneeId, assigneeEmail, assigneeGithubId, creatorId, creatorEmail, creatorGithubId } = hints;
  const [settings] = await db.select({ config: linearSettings.config }).from(linearSettings).where(eq(linearSettings.id, "factory"));
  const hive = settings?.config.hiveUserId ?? null;
  const isHive = (id: string | null | undefined) => hive !== null && id === hive;
  const by = (githubId?: number | null, email?: string | null) => [
    githubId != null && eq(user.githubId, githubId),
    !!email && eq(sql`lower(${user.email})`, email.toLowerCase()),
  ];
  for (const where of [...(isHive(assigneeId) ? [] : by(assigneeGithubId, assigneeEmail)), ...(isHive(creatorId) ? [] : by(creatorGithubId, creatorEmail))]) {
    if (!where) continue;
    const [found] = await db.select({ id: user.id }).from(user).where(where);
    if (found) return found.id;
  }
  return null;
}
