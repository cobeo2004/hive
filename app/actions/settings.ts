"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { currentUser } from "@/lib/auth/server";
import { syncGithubLabelsNow } from "@/lib/sources";
import { saveSourceChoice, writeSourceChoice } from "@/lib/job-sources";
import { saveLinear, saveLinearSettings as writeLinear, type LinearConfig } from "@/lib/linear-settings";
import { reportedHarnesses } from "@/lib/machine";
import { saveSettings as save, writeSettings, type SettingsInput } from "@/lib/settings";

const user = currentUser;

export async function saveSettings(input: SettingsInput) {
  return save(
    {
      user,
      harnesses: async () => reportedHarnesses(await db.select().from(machines), Date.now()),
      save: (choice, by) => writeSettings(db, choice, by, new Date()),
    },
    input,
  );
}

export async function saveLinearSettings(input: LinearConfig) {
  return saveLinear({ user, save: (config, by) => writeLinear(db, config, by, new Date()) }, input);
}

/** Saves where jobs come from, then (R15) makes sure every enabled repo has GitHub Issues' labels. A repo that cannot be reached is a note, not a failed save. */
export async function saveJobSources(choice: string) {
  const outcome = await saveSourceChoice({ user, save: (picked, by) => writeSourceChoice(db, picked, by) }, choice);
  if (!outcome.ok) return outcome;
  const problems = await syncGithubLabelsNow(db).catch((error) => [error instanceof Error ? error.message : String(error)]);
  return { ok: true as const, labelNote: problems.length > 0 ? `Some labels were not created: ${problems.join("; ")}` : undefined };
}
