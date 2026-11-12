"use server";

import { db } from "@/db/client";
import { currentUser } from "@/lib/auth/server";
import { addPoolAccount as add, disconnectPoolAccount as disconnect, renamePoolAccount as rename } from "@/lib/pool-accounts";

// The key goes in here and nowhere back out: outcomes carry only a status and a fixed message.
const deps = () => ({ user: currentUser, db, publicKey: process.env.HIVE_CREDS_PUBLIC_KEY });

export const addPoolAccount = async (input: unknown) => add(deps(), input);
export const renamePoolAccount = async (input: unknown) => rename(deps(), input);
export const disconnectPoolAccount = async (input: unknown) => disconnect(deps(), input);
