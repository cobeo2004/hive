"use server";

import { db } from "@/db/client";
import { machines } from "@/db/schema";
import { currentUser } from "@/lib/auth/server";
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
