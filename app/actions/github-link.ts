"use server";

import { db } from "@/db/client";
import { assertMember, currentUser } from "@/lib/auth/server";
import { readAppFile } from "@/lib/github/app";
import { type LinkPoll, pollLink, startLink, unlink } from "@/lib/github-link";

async function me() {
  await assertMember();
  const id = (await currentUser())?.id;
  if (!id) throw new Error("Sign in to Hive first.");
  return id;
}

/** The App's client id: GITHUB_APP_CLIENT_ID (Vercel has no app file), else the runner's app file. */
function clientId() {
  try {
    return process.env.GITHUB_APP_CLIENT_ID || readAppFile().client_id;
  } catch {
    return null;
  }
}

const deps = () => {
  const id = clientId();
  const secret = process.env.BETTER_AUTH_SECRET;
  return id && secret ? { db, clientId: id, secret } : null;
};

export async function startGithubLink() {
  const userId = await me();
  const d = deps();
  if (!d) return { ok: false as const, message: "Linking GitHub is not set up: set GITHUB_APP_CLIENT_ID to the GitHub App's client id." };
  const started = await startLink(d, userId);
  if (!started) return { ok: false as const, message: "GitHub did not give a code. Is Device Flow enabled on the GitHub App?" };
  return { ok: true as const, ...started };
}

export async function pollGithubLink(handle: string): Promise<LinkPoll> {
  const userId = await me();
  const d = deps();
  if (!d) return { status: "failed" };
  return pollLink(d, userId, handle);
}

export async function unlinkGithub() {
  await unlink(db, await me());
}
