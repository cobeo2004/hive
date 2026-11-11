import { eq, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type * as schema from "../db/schema";
import { linearSettings as table } from "../db/schema";
import type { SessionUser } from "./auth/owner";
import { envLinearDefaults, LINEAR_SETTINGS_ID } from "./linear-settings";
import { sourceChoiceSchema, type SourceChoice } from "./source-choice";

// Where jobs come from (R13, R14): Linear, GitHub Issues or both, one choice an admin makes. It lives
// in the one row Settings → Linear already shares between the panel and the runner (config.sources).

type Db = NodePgDatabase<typeof schema>;
type Env = Readonly<Record<string, string | undefined>>;

/** What an admin chose; Linear alone until one does, which is what every install ran before there was a choice. */
export async function readSourceChoice(db: Db): Promise<SourceChoice> {
  const [row] = await db
    .select({ sources: sql<unknown>`${table.config}->'sources'` })
    .from(table)
    .where(eq(table.id, LINEAR_SETTINGS_ID));
  return sourceChoiceSchema.catch("linear").parse(row?.sources);
}

/** Which sources take new work. `FACTORY_GITHUB_ISSUES=on` turns GitHub Issues on whatever was chosen (the override the switch had before it moved here). */
export async function sourcesOn(db: Db, env: Env = process.env) {
  const choice = await readSourceChoice(db);
  return { linear: choice !== "github", github: choice !== "linear" || env.FACTORY_GITHUB_ISSUES === "on" };
}

export type SourceSaveOutcome = { ok: true } | { ok: false; status: 400 | 403 | 502; message: string };

/** Saves the choice into the Linear settings row, creating it from the env defaults if there is none; the other keys are kept. */
export async function saveSourceChoice(
  deps: { user: () => Promise<SessionUser | null | undefined>; save: (choice: SourceChoice, by: string) => Promise<void> },
  input: unknown,
): Promise<SourceSaveOutcome> {
  const user = await deps.user();
  // An admin chooses during first-run setup, before setup_done_at is stamped, so the check is the role and TOTP, not isAdmin.
  if (user?.role !== "admin" || user.twoFactorEnabled !== true) return { ok: false, status: 403, message: "Only an admin can change where jobs come from." };
  const parsed = sourceChoiceSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: "Choose Linear, GitHub Issues or both." };
  try {
    await deps.save(parsed.data, user.email);
    return { ok: true };
  } catch (error) {
    return { ok: false, status: 502, message: `Could not save: ${error instanceof Error ? error.message : String(error)}` };
  }
}

export async function writeSourceChoice(db: Db, choice: SourceChoice, by: string, at: Date = new Date()) {
  const sources = JSON.stringify({ sources: choice });
  const config = { ...envLinearDefaults(), sources: choice }; // the column's type lists only the Linear keys; the jsonb takes any
  await db
    .insert(table)
    .values({ id: LINEAR_SETTINGS_ID, config, updated_by: by, updated_at: at })
    .onConflictDoUpdate({ target: table.id, set: { config: sql`${table.config} || ${sources}::jsonb`, updated_by: by, updated_at: at } });
}
