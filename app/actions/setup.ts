"use server";

import { currentUser } from "@/lib/auth/server";
import { saveOwnName } from "@/lib/members";

// /setup's Account step (R5): the one field it saves is the signed-in user's own name.
const deps = { user: currentUser };

export async function saveName(name: string) {
  return saveOwnName(deps, name);
}
