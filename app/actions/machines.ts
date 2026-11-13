"use server";

import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { checkMachineNow as check } from "@/lib/machine-check";

export async function checkMachineNow(machineId: string) {
  return check({ db, user: currentUser }, machineId);
}
