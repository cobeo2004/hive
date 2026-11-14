"use server";

import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { checkMachineNow as check } from "@/lib/machine-check";
import { newJobDeps } from "@/lib/new-job-deps";
import { runTestJob as run } from "@/lib/settings-test-job";

export async function checkMachineNow(machineId: string) {
  return check({ db, user: currentUser }, machineId);
}

export async function runTestJob() {
  return run({ db, user: currentUser, newJob: newJobDeps });
}
