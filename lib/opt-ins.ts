import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import { db } from "@/db/client";
import type * as schema from "@/db/schema";
import { linearOptIns, user } from "@/db/schema";
import type { MembersDeps } from "@/lib/members";
import { forbidInTest } from "@/lib/test-mode";

// /setup's Linear step (R28): the signed-in user's Linear opt-ins, and whether Linear knows their email.

export type OptIns = { assigned: boolean; plan_approval: boolean };
export const NO_OPT_INS: OptIns = { assigned: false, plan_approval: false };
type Refused = { ok: false; status: 400 | 403; message: string };

const optInsSchema = z.object({ assigned: z.boolean(), plan_approval: z.boolean() });

/** The signed-in user's opt-ins; both off when signed out or never saved. */
export async function readOptIns(deps: MembersDeps): Promise<OptIns> {
  const actor = await deps.user();
  if (!actor) return NO_OPT_INS;
  const [row] = await db
    .select({ assigned: linearOptIns.assigned, plan_approval: linearOptIns.plan_approval })
    .from(linearOptIns)
    .innerJoin(user, eq(user.id, linearOptIns.user_id))
    .where(eq(user.email, actor.email));
  return row ?? NO_OPT_INS;
}

/** Lowercased emails of everyone opted in to "assigned" (R7b); the poll matches a Linear assignee against them. */
export async function assignedOptInEmails(on: NodePgDatabase<typeof schema> = db): Promise<Set<string>> {
  const rows = await on
    .select({ email: user.email })
    .from(linearOptIns)
    .innerJoin(user, eq(user.id, linearOptIns.user_id))
    .where(eq(linearOptIns.assigned, true));
  return new Set(rows.map((r) => r.email.toLowerCase()));
}

/** Saves the signed-in user's own opt-ins; the row is found by the session's email, never by input. */
export async function saveOptIns(deps: MembersDeps, input: unknown): Promise<{ ok: true; optIns: OptIns } | Refused> {
  const actor = await deps.user();
  if (!actor) return { ok: false, status: 403, message: "Sign in to Hive first." };
  const parsed = optInsSchema.safeParse(input);
  if (!parsed.success) return { ok: false, status: 400, message: "Opt-ins are assigned and plan_approval, each on or off." };
  const { assigned, plan_approval } = parsed.data;
  const [me] = await db.select({ id: user.id }).from(user).where(eq(user.email, actor.email));
  if (!me) return { ok: false, status: 400, message: "No such member." };
  const updated_at = new Date();
  await db
    .insert(linearOptIns)
    .values({ user_id: me.id, assigned, plan_approval, updated_at })
    .onConflictDoUpdate({ target: linearOptIns.user_id, set: { assigned, plan_approval, updated_at } });
  return { ok: true, optIns: { assigned, plan_approval } };
}

export type LinearUsers = { userByEmail: (email: string) => Promise<{ id: string } | null> };
export type LinearMatch = "matched" | "no-match" | "not-connected";

/** Like Slack's lookup, an outage only shows the no-match note. */
export async function linearMatch(email: string, users: LinearUsers | null): Promise<LinearMatch> {
  if (!users) return "not-connected";
  try {
    return (await users.userByEmail(email)) ? "matched" : "no-match";
  } catch {
    return "no-match";
  }
}

export function linearCardNote(match: LinearMatch, email: string): string {
  if (match === "matched") return "Matched by email";
  if (match === "no-match") return `No Linear user with ${email}`;
  return "Linear isn't connected yet";
}

const usersSchema = z.object({ data: z.object({ users: z.object({ nodes: z.array(z.object({ id: z.string() })) }) }) });

// Lives here, not in lib/linear.ts, to stay off a file a parallel plan (m2-03) edits; fold it into linearClient later.
/** Linear users by email through Hive's API key (R28: no OAuth); null when no key is configured. */
export function linearUsers(): LinearUsers | null {
  const key = process.env.LINEAR_API_KEY?.trim();
  if (!key) return null;
  return {
    async userByEmail(email) {
      forbidInTest("the Linear API");
      const res = await fetch("https://api.linear.app/graphql", {
        method: "POST",
        headers: { authorization: key, "content-type": "application/json" },
        body: JSON.stringify({ query: "query($email: String!) { users(filter: { email: { eq: $email } }) { nodes { id } } }", variables: { email } }),
        signal: AbortSignal.timeout(10_000),
      });
      return usersSchema.parse(await res.json()).data.users.nodes[0] ?? null;
    },
  };
}
