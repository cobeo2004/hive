"use server";

import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import type { JobId } from "@/lib/sources/shapes";
import { requestPairing, takePairing, type PairingDeps } from "@/lib/t3-pairing";

const deps: PairingDeps = {
  db,
  user: currentUser,
};

export async function requestT3Pairing(jobId: JobId) {
  return requestPairing(deps, jobId);
}

export async function takeT3Pairing(intentId: string) {
  return takePairing(deps, intentId);
}
