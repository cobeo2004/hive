"use server";

import { db } from "@/db/client";
import { cancelLogin, disconnectOwnAccount, loginForCard, readLogin, setAccountShared, writeCode, writeLogin } from "@/lib/account-logins";
import { currentUser } from "@/lib/auth/server";
import { addPoolAccount as add, disconnectPoolAccount as disconnect, renamePoolAccount as rename } from "@/lib/pool-accounts";

// The key goes in here and nowhere back out: outcomes carry only a status and a fixed message.
const deps = () => ({ user: currentUser, db, publicKey: process.env.HIVE_CREDS_PUBLIC_KEY });

export const addPoolAccount = async (input: unknown) => add(deps(), input);
export const renamePoolAccount = async (input: unknown) => rename(deps(), input);
export const disconnectPoolAccount = async (input: unknown) => disconnect(deps(), input);

// Connecting your own account (R9b; the UI is Your accounts, R27): start, then poll accountLogin for the link and code (null once it ended). Each acts for the signed-in user only.
async function member() {
  const user = await currentUser();
  if (user?.twoFactorEnabled !== true || !user.id) throw new Error("Sign in to Hive first.");
  return user.id;
}

export async function startAccountLogin(provider: "claude" | "codex") {
  if (provider !== "claude" && provider !== "codex") throw new Error("A provider is claude or codex.");
  return { loginId: await writeLogin(db, await member(), provider) };
}

export async function accountLogin(loginId: string) {
  return loginForCard(await readLogin(db, await member(), loginId));
}

/** Claude only: the code the user pasted back after signing in. False when the login is not waiting for one. */
export async function submitLoginCode(loginId: string, code: string) {
  return writeCode(db, await member(), loginId, code);
}

export async function cancelAccountLogin(loginId: string) {
  await cancelLogin(db, await member(), loginId);
}

/** Your own account only; anyone else's id is 403 (Q21). */
export async function disconnectMyAccount(accountId: string) {
  return disconnectOwnAccount(db, await member(), String(accountId));
}

/** Share your own account with the team pool, or stop; anyone else's id is 403. */
export async function shareMyAccount(accountId: string, shared: boolean) {
  return setAccountShared(db, await member(), String(accountId), shared === true);
}
