import { NextResponse, type NextRequest } from "next/server";
import { session, sessionUser } from "@/lib/auth/server";

const LOGIN = "/auth/sign-in";
const SETUP = "/setup";

// Session contract (R3, R33): Better Auth issues a session only after TOTP for an enrolled user, or right after
// a setup or invite link for one who hasn't enrolled yet. Until TOTP is on and setup is done, only /setup is open.
export async function proxy(request: NextRequest) {
  const user = sessionUser(await session.read(request.headers));
  const path = request.nextUrl.pathname;
  const api = path.startsWith("/api/");
  if (!user) {
    return api ? NextResponse.json({ error: "Unauthorized" }, { status: 401 }) : NextResponse.redirect(new URL(LOGIN, request.url));
  }
  const setupPath = path === SETUP || path.startsWith(`${SETUP}/`) || path.startsWith(`${SETUP}.`);
  if (user.twoFactorEnabled !== true || !user.setupDoneAt) {
    if (setupPath) return NextResponse.next();
    return api ? NextResponse.json({ error: "Finish setup first" }, { status: 403 }) : NextResponse.redirect(new URL(SETUP, request.url));
  }
  // A finished user has no setup left to do.
  if (setupPath) return NextResponse.redirect(new URL("/", request.url));
  return NextResponse.next();
}

// Each exclusion ends at a path boundary, or at the .rsc and .segments/ suffixes Next adds for prerendered pages.
// The link pages check their token on the server. The public paths have no session: ingest checks its Bearer
// secret, webhooks and Slack their signatures.
export const config = {
  matcher: [
    "/((?!(?:auth/sign-in|auth/setup|auth/accept|auth/reset|auth/forbidden|api/auth|api/slack|api/ingest|api/webhooks|_next/static|_next/image|favicon\\.ico)(?:/|$|\\.rsc$|\\.segments/)).*)",
  ],
};
