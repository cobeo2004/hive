import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../db/schema";
import { linearSettings as table } from "../db/schema";
import { isAdmin, type SessionUser } from "./auth/owner";

// The Linear teams Hive serves, its pickup label and Hive's Linear user (R7a), edited in Settings → Linear.
// FACTORY_TEAM_KEY and FACTORY_LABEL are only the defaults until an admin saves the one row.

export const LINEAR_SETTINGS_ID = "factory";

type Db = NodePgDatabase<typeof schema>;

export const linearSettingsSchema = z.object({
  teamKeys: z
    .array(
      z
        .string()
        .trim()
        .regex(/^[A-Z][A-Z0-9_]*$/, "Team keys are uppercase, like MOB."),
    )
    .min(1, "Add at least one team."),
  label: z.string().trim().min(1, "Name the pickup label."),
  hiveUserId: z.string().trim().min(1).nullable(),
});
export type LinearConfig = z.infer<typeof linearSettingsSchema>;
export type LinearSettings = LinearConfig & { saved: { by: string; at: Date } | null };

type Env = Readonly<Record<string, string | undefined>>;

export const envLinearDefaults = (env: Env = process.env): LinearConfig => ({
  teamKeys: [env.FACTORY_TEAM_KEY ?? "FAC"],
  label: env.FACTORY_LABEL ?? "hive",
  hiveUserId: null,
});

export async function linearSettings(db: Db, env: Env = process.env): Promise<LinearSettings> {
  const [row] = await db.select().from(table).where(eq(table.id, LINEAR_SETTINGS_ID));
  return row ? { ...row.config, saved: { by: row.updated_by, at: row.updated_at } } : { ...envLinearDefaults(env), saved: null };
}

export async function saveLinearSettings(db: Db, config: LinearConfig, by: string, at: Date) {
  const values = { config, updated_by: by, updated_at: at };
  await db
    .insert(table)
    .values({ id: LINEAR_SETTINGS_ID, ...values })
    // Merged, so the keys this form does not own (config.sources) survive its save.
    .onConflictDoUpdate({ target: table.id, set: { ...values, config: sql`${table.config} || ${JSON.stringify(config)}::jsonb` } });
}

type LinearSaveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 502; message: string };

export async function saveLinear(
  deps: { user: () => Promise<SessionUser | null | undefined>; save: (config: LinearConfig, by: string) => Promise<void> },
  input: unknown,
): Promise<LinearSaveOutcome> {
  const user = await deps.user();
  if (!user || !isAdmin(user)) return { ok: false, status: 403, message: "Only an admin can change the Linear settings." };
  const parsed = linearSettingsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: parsed.error.issues[0]?.message ?? "The Linear settings are not valid." };
  try {
    await deps.save(parsed.data, user.email);
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not save the Linear settings: ${error instanceof Error ? error.message : String(error)}` };
  }
}

/** The one org-wide webhook: every public team delivers, so changing teamKeys never needs a reinstall. */
export const linearWebhookInput = ({ url, secret }: { url: string; secret: string | undefined }) => ({
  url,
  allPublicTeams: true,
  resourceTypes: ["Issue", "Comment"],
  secret,
  label: "Hive intake",
});

/** Hive's Linear user's name, or null when there is no key or Linear can't say. */
export async function linearUserName(apiKey: string | undefined, id: string | null): Promise<string | null> {
  if (!apiKey || !id) return null;
  try {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: { authorization: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ query: "query($id: String!) { user(id: $id) { name } }", variables: { id } }),
      signal: AbortSignal.timeout(5_000),
    });
    const json = (await res.json()) as { data?: { user?: { name?: string } | null } };
    return json.data?.user?.name ?? null;
  } catch {
    return null;
  }
}
