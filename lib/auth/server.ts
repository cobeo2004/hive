import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { admin, twoFactor } from "better-auth/plugins";
import { headers } from "next/headers";
import { cache } from "react";
import { db } from "@/db/client";
import { account, session as sessions, twoFactor as twoFactors, user, verification } from "@/db/schema";
import { panelUrl } from "@/lib/slack";
import { isAdmin, isMember, type SessionUser } from "./owner";

export const auth = betterAuth({
  secret: process.env.BETTER_AUTH_SECRET,
  baseURL: panelUrl(),
  database: drizzleAdapter(db, { provider: "pg", schema: { user, session: sessions, account, verification, twoFactor: twoFactors } }),
  // Accounts come only from the setup token or an invite (R32), created server-side in lib/access-links.ts.
  emailAndPassword: { enabled: true, disableSignUp: true },
  user: { additionalFields: { setupDoneAt: { type: "date", required: false, input: false } } },
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      // Roles change only through Settings → Members, which guards the last admin; the admin plugin's HTTP routes are closed.
      if (ctx.path.startsWith("/admin/") && ctx.request) throw new APIError("FORBIDDEN");
      // No trusted devices: every sign-in asks for the code (R33).
      if (ctx.path.startsWith("/two-factor/verify-") && ctx.body) return { context: { body: { ...ctx.body, trustDevice: false } } };
    }),
  },
  plugins: [admin({ defaultRole: "engineer" }), twoFactor({ issuer: "Hive" }), nextCookies()],
});

/** The session behind a request: the proxy passes its request's headers, everything else reads the current request's. Tests stub `read`. */
export const session = {
  read: async (requestHeaders?: Headers) => auth.api.getSession({ headers: requestHeaders ?? (await headers()) }),
};

export function sessionUser(found: Awaited<ReturnType<typeof session.read>>): SessionUser | null {
  if (!found) return null;
  const { id, email, name, role, twoFactorEnabled, setupDoneAt } = found.user;
  return { id, email, name, role, twoFactorEnabled, setupDoneAt };
}

/** The signed-in user, read once per request (D7). */
export const currentUser = cache(async () => sessionUser(await session.read()));

export const assertMember = cache(async () => {
  if (!isMember(await currentUser())) throw new Error("Sign in to Hive first.");
});

export const assertAdmin = cache(async () => {
  if (!isAdmin(await currentUser())) throw new Error("Only an admin can do that.");
});
