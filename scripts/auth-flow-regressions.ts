import "./test-guard";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { sql } from "drizzle-orm";
import { NextRequest } from "next/server";

// The session contract (R3, R33) through Better Auth's real handler on the test database, and the proxy reading it.
const PANEL = "http://localhost:3000";
process.env.FACTORY_PANEL_URL = PANEL;
const { db } = await import("../db/client");
const { acceptInvite, acceptReset, acceptSetup, createLink } = await import("../lib/access-links");
const { proxy } = await import("../proxy");
const { GET, POST } = await import("../app/api/auth/[...path]/route");

const PASSWORD = "correct horse battery staple 42";
const ADMIN = "flow-admin@unibuz.com.au";
const ENG = "flow-eng@unibuz.com.au";

/** One browser: a cookie jar that follows Set-Cookie. */
function browser() {
  const jar = new Map<string, string>();
  const keep = (response: Response) => {
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(";");
      const [name, value] = [pair!.slice(0, pair!.indexOf("=")), pair!.slice(pair!.indexOf("=") + 1)];
      if (!value || attributes.some((a) => /max-age=0\b/i.test(a.trim()))) jar.delete(name);
      else jar.set(name, value);
    }
    return response;
  };
  const cookie = () => [...jar].map(([k, v]) => `${k}=${v}`).join("; ");
  const headers = () => ({ cookie: cookie(), origin: PANEL, "content-type": "application/json" });
  return {
    jar,
    post: async (path: string, body: object) => keep(await POST(new Request(`${PANEL}/api/auth${path}`, { method: "POST", headers: headers(), body: JSON.stringify(body) }))),
    get: async (path: string) => keep(await GET(new Request(`${PANEL}/api/auth${path}`, { headers: headers() }))),
    /** What the proxy does with this browser's cookies: 200 passes, else the redirect's path or the status. */
    reach: async (path: string) => {
      const response = await proxy(new NextRequest(`${PANEL}${path}`, { headers: { cookie: cookie() } }));
      return response.status === 307 ? new URL(response.headers.get("location")!).pathname : response.status;
    },
  };
}
const hasSession = (b: ReturnType<typeof browser>) => [...b.jar.keys()].some((k) => k.endsWith("session_token"));
/** RFC 6238 from the otpauth URI's base32 secret, as an authenticator app computes it. */
function codeFor(base32: string) {
  const bits = [...base32.replace(/=+$/, "")].map((c) => "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567".indexOf(c).toString(2).padStart(5, "0")).join("");
  const key = Buffer.from(bits.match(/.{8}/g)!.map((b) => parseInt(b, 2)));
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const mac = createHmac("sha1", key).update(counter).digest();
  const at = mac[mac.length - 1]! & 0xf;
  return String((mac.readUInt32BE(at) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

async function reset() {
  await db.execute(sql`delete from access_links`);
  await db.execute(sql`delete from "user"`);
}
await reset();
try {
  // --- the setup link's admin gets a session that reaches only /setup until TOTP is on.
  await acceptSetup(await createLink("setup", null, 3_600_000), { name: "Admin", email: ADMIN, password: PASSWORD });
  const first = browser();
  assert.equal((await first.post("/sign-in/email", { email: ADMIN, password: PASSWORD })).status, 200);
  assert.ok(hasSession(first), "a user without TOTP gets a session");
  assert.equal(await first.reach("/"), "/setup", "before TOTP, a page sends them to /setup");
  assert.equal(await first.reach("/settings"), "/setup");
  assert.equal(await first.reach("/api/live"), 403, "and the API refuses them");
  assert.equal(await first.reach("/setup"), 200, "/setup is reachable");

  // --- enrolment in /setup: enable returns the URI and backup codes, a code turns TOTP on.
  const enabled = await first.post("/two-factor/enable", { password: PASSWORD });
  assert.equal(enabled.status, 200);
  const { totpURI, backupCodes } = (await enabled.json()) as { totpURI: string; backupCodes: string[] };
  const secret = new URL(totpURI).searchParams.get("secret")!;
  assert.equal(new URL(totpURI).searchParams.get("issuer"), "Hive");
  assert.ok(backupCodes.length > 0);
  assert.equal((await first.post("/two-factor/verify-totp", { code: await codeFor(secret) })).status, 200);
  assert.equal(await first.reach("/"), "/setup", "TOTP on but setup unfinished still means /setup");
  await db.execute(sql`update "user" set setup_done_at = now() where email = ${ADMIN}`);
  assert.equal(await first.reach("/"), 200, "after setup the panel opens");
  assert.equal(await first.reach("/api/live"), 200);

  // --- the password alone gives an enrolled user no session.
  const second = browser();
  const signedIn = await second.post("/sign-in/email", { email: ADMIN, password: PASSWORD });
  assert.equal(((await signedIn.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, true);
  assert.ok(!hasSession(second), "no session after the password step");
  assert.equal(await second.reach("/"), "/auth/sign-in", "the password step reaches no page");
  assert.equal(await second.reach("/api/live"), 401, "nor the API");
  // The code completes it; asking to trust the device is ignored.
  assert.equal((await second.post("/two-factor/verify-totp", { code: await codeFor(secret), trustDevice: true })).status, 200);
  assert.ok(hasSession(second));
  assert.ok(![...second.jar.keys()].some((k) => k.includes("trust_device")), "no trusted-device cookie");
  assert.equal(await second.reach("/"), 200);
  // With that browser's cookies, the next sign-in still asks for the code.
  await second.post("/sign-out", {});
  const again = await second.post("/sign-in/email", { email: ADMIN, password: PASSWORD });
  assert.equal(((await again.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, true, "no device is trusted");

  // --- a backup code works once.
  const backup = browser();
  await backup.post("/sign-in/email", { email: ADMIN, password: PASSWORD });
  assert.equal((await backup.post("/two-factor/verify-backup-code", { code: backupCodes[0] })).status, 200);
  assert.equal(await backup.reach("/"), 200, "a backup code signs in");
  const reused = browser();
  await reused.post("/sign-in/email", { email: ADMIN, password: PASSWORD });
  assert.notEqual((await reused.post("/two-factor/verify-backup-code", { code: backupCodes[0] })).status, 200, "a used backup code is refused");
  assert.ok(!hasSession(reused));

  // --- sign-up is closed, and the admin plugin's HTTP routes are shut.
  const stranger = browser();
  assert.notEqual((await stranger.post("/sign-up/email", { email: "x@unibuz.com.au", password: PASSWORD, name: "X" })).status, 200, "sign-up is closed");
  assert.equal((await first.post("/admin/set-role", { userId: "x", role: "admin" })).status, 403, "even an admin can't use the admin plugin's routes");

  // --- an invite: a session that reaches only /setup before TOTP.
  await acceptInvite(await createLink("invite", ENG, 60_000), { name: "Eng", password: PASSWORD });
  const invited = browser();
  await invited.post("/sign-in/email", { email: ENG, password: PASSWORD });
  assert.equal(await invited.reach("/"), "/setup", "after invite acceptance, only /setup");
  assert.equal(await invited.reach("/inbox"), "/setup");
  assert.equal(await invited.reach("/setup"), 200);

  // --- a reset sets the password, signs no one in, and ends the user's sessions.
  await acceptReset(await createLink("reset", ADMIN, 60_000), { password: "a brand new password 7" });
  assert.equal(await first.reach("/"), "/auth/sign-in", "after a reset, the old session is gone");
  assert.equal(await backup.reach("/"), "/auth/sign-in");
  const newPassword = browser();
  assert.notEqual((await newPassword.post("/sign-in/email", { email: ADMIN, password: PASSWORD })).status, 200, "the old password no longer works");
  const fresh = await newPassword.post("/sign-in/email", { email: ADMIN, password: "a brand new password 7" });
  assert.equal(((await fresh.json()) as { twoFactorRedirect?: boolean }).twoFactorRedirect, true, "the new password still needs the code");
} finally {
  await reset();
}
console.log("auth flow regressions passed");
process.exit(0);
