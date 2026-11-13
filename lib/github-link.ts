import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import { eq } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import { z } from "zod";
import type * as schema from "../db/schema";
import { user } from "../db/schema";
import { GITHUB_API } from "./github/app";

// Link GitHub (R27f): the GitHub App's user device flow. The user token reads /user once and is dropped; only login and id are kept.
// The device code never reaches the browser: it travels as a handle sealed with a key from the auth secret, bound to the user.

type Db = Pick<NodePgDatabase<typeof schema>, "update">;
type LinkDeps = { db: Db; clientId: string; secret: string; fetch?: typeof fetch; now?: () => number };
export type LinkPoll = { status: "pending"; interval: number } | { status: "linked"; login: string } | { status: "expired" | "denied" | "taken" | "failed" };

const GITHUB = "https://github.com";
const json = { Accept: "application/json", "Content-Type": "application/json" };

const keyOf = (secret: string) => Buffer.from(hkdfSync("sha256", secret, "", "hive-github-link-v1", 32));
function sealHandle(secret: string, data: object) {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyOf(secret), iv);
  const body = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64url");
}
function openHandle(secret: string, handle: string) {
  try {
    const raw = Buffer.from(handle, "base64url");
    const decipher = createDecipheriv("aes-256-gcm", keyOf(secret), raw.subarray(0, 12)).setAuthTag(raw.subarray(12, 28));
    return z
      .object({ u: z.string(), c: z.string(), e: z.number() })
      .parse(JSON.parse(Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString()));
  } catch {
    return null;
  }
}

const codeSchema = z.object({ device_code: z.string(), user_code: z.string(), verification_uri: z.string(), expires_in: z.number(), interval: z.number() });

/** Asks GitHub for a device code. The browser gets the user code, where to enter it, and the sealed handle. */
export async function startLink(d: LinkDeps, userId: string) {
  const res = await (d.fetch ?? fetch)(`${GITHUB}/login/device/code`, { method: "POST", headers: json, body: JSON.stringify({ client_id: d.clientId }) });
  const code = codeSchema.safeParse(await res.json().catch(() => null)).data;
  // "Enable Device Flow" off on the App answers device_flow_disabled: no code.
  if (!res.ok || !code) return null;
  const handle = sealHandle(d.secret, { u: userId, c: code.device_code, e: (d.now ?? Date.now)() + code.expires_in * 1000 });
  return { userCode: code.user_code, verificationUri: code.verification_uri, interval: code.interval, handle };
}

/** One poll of GitHub for the token; on success reads /user, stores login and id, and lets the token go. */
export async function pollLink(d: LinkDeps, userId: string, handle: string): Promise<LinkPoll> {
  const open = openHandle(d.secret, handle);
  if (!open || open.u !== userId) return { status: "failed" };
  if (open.e <= (d.now ?? Date.now)()) return { status: "expired" };
  const f = d.fetch ?? fetch;
  const res = await f(`${GITHUB}/login/oauth/access_token`, {
    method: "POST",
    headers: json,
    body: JSON.stringify({ client_id: d.clientId, device_code: open.c, grant_type: "urn:ietf:params:oauth:grant-type:device_code" }),
  });
  const got = z
    .object({ access_token: z.string().optional(), error: z.string().optional(), interval: z.number().optional() })
    .safeParse(await res.json().catch(() => null)).data;
  if (got?.error === "authorization_pending" || got?.error === "slow_down") return { status: "pending", interval: got.interval ?? 5 };
  if (got?.error === "expired_token") return { status: "expired" };
  if (got?.error === "access_denied") return { status: "denied" };
  if (!got?.access_token) return { status: "failed" };
  const me = await f(`${GITHUB_API}/user`, { headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${got.access_token}` } });
  const who = z.object({ id: z.number(), login: z.string() }).safeParse(await me.json().catch(() => null)).data;
  if (!me.ok || !who) return { status: "failed" };
  try {
    await d.db.update(user).set({ githubId: who.id, githubLogin: who.login }).where(eq(user.id, userId));
  } catch (error) {
    // The unique id: this GitHub account is already another Hive user's.
    if ((error as { cause?: { code?: string } }).cause?.code === "23505" || (error as { code?: string }).code === "23505") return { status: "taken" };
    throw error;
  }
  return { status: "linked", login: who.login };
}

export const unlink = (db: Db, userId: string) => db.update(user).set({ githubId: null, githubLogin: null }).where(eq(user.id, userId));
