"use server";

import { currentUser } from "@/lib/auth/server";
import { createInvite as invite, createMemberResetLink, finishSetup as finish, listMembers as list, setMemberRole as setRole, type Role } from "@/lib/members";

const deps = { user: currentUser };

export async function listMembers() {
  return list(deps);
}

export async function setMemberRole(userId: string, role: Role) {
  return setRole(deps, userId, role);
}

export async function createInvite(email: string) {
  return invite(deps, email);
}

export async function createResetLink(email: string) {
  return createMemberResetLink(deps, email);
}

export async function finishSetup() {
  return finish(deps);
}
