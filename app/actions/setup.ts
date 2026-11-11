"use server";

import { currentUser } from "@/lib/auth/server";
import { saveOwnName } from "@/lib/members";
import { saveOptIns, type OptIns } from "@/lib/opt-ins";

// /setup's Account step (R5) saves the signed-in user's own name; its Linear step (R28) their own opt-ins.
const deps = { user: currentUser };

export async function saveName(name: string) {
  return saveOwnName(deps, name);
}

export async function saveLinearOptIns(optIns: OptIns) {
  return saveOptIns(deps, optIns);
}
