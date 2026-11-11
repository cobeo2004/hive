import { eq } from "drizzle-orm";
import { db } from "../db/client";
import { linearOptIns, repoSstackConfig } from "../db/schema";
import type { Autonomy } from "./merge-decision";

declare const Bun: { TOML: { parse(text: string): unknown } };

export type PlanGate = "auto" | "inbox";

export function explicitGate(files: Record<string, string>): PlanGate | undefined {
  try {
    const gate = (Bun.TOML.parse(files[".sstack/config.toml"] ?? "") as { unattended?: { plan_gate?: unknown } }).unattended?.plan_gate;
    return gate === "auto" || gate === "inbox" ? gate : undefined;
  } catch {
    return undefined;
  }
}

export function planGate({ optIn, explicit, autonomy }: { optIn: boolean; explicit: string | undefined; autonomy: Autonomy }): PlanGate {
  if (optIn) return "inbox";
  if (explicit === "auto" || explicit === "inbox") return explicit;
  return autonomy === "auto" ? "auto" : "inbox";
}

export async function launchEnv(owner: string | null | undefined, repo: string, autonomy: Autonomy) {
  const [opt] = owner ? await db.select({ on: linearOptIns.plan_approval }).from(linearOptIns).where(eq(linearOptIns.user_id, owner)) : [];
  const [snap] = await db.select({ files: repoSstackConfig.files }).from(repoSstackConfig).where(eq(repoSstackConfig.repo, repo));
  return { SSTACK_UNATTENDED: "1", SSTACK_PLAN_GATE: planGate({ optIn: opt?.on ?? false, explicit: snap && explicitGate(snap.files), autonomy }) };
}
