import "./test-guard";
import assert from "node:assert/strict";
import { NextRequest } from "next/server";

const { session, assertMember, assertAdmin } = await import("../lib/auth/server");
const { proxy, config } = await import("../proxy");

// The session contract (R3, R33), with stubbed sessions; auth-flow-regressions runs Better Auth's real handler.
type Who = "anonymous" | "enrolling" | "unfinished" | "engineer" | "admin";
const DONE = new Date("2026-11-10T00:00:00Z");
const USERS: Record<Who, object | null> = {
  anonymous: null,
  // Just accepted a setup or invite link: no TOTP yet.
  enrolling: { id: "u1", email: "new@unibuz.com.au", name: "New", role: "engineer", twoFactorEnabled: false, setupDoneAt: null },
  // TOTP on, but setup not finished.
  unfinished: { id: "u2", email: "half@unibuz.com.au", name: "Half", role: "engineer", twoFactorEnabled: true, setupDoneAt: null },
  engineer: { id: "u3", email: "eng@unibuz.com.au", name: "Eng", role: "engineer", twoFactorEnabled: true, setupDoneAt: DONE },
  admin: { id: "u4", email: "admin@unibuz.com.au", name: "Admin", role: "admin", twoFactorEnabled: true, setupDoneAt: DONE },
};
function signInAs(who: Who) {
  const user = USERS[who];
  Object.assign(session, { read: async () => (user ? { user, session: {} } : null) });
}

async function request(who: Who, path: string, method = "GET") {
  signInAs(who);
  return proxy(new NextRequest(`http://localhost:3000${path}`, { method }));
}

const anonymousPage = await request("anonymous", "/");
assert.equal(anonymousPage.status, 307, "a page without a session redirects");
assert.equal(anonymousPage.headers.get("location"), "http://localhost:3000/auth/sign-in");
const anonymousLive = await request("anonymous", "/api/live");
assert.equal(anonymousLive.status, 401, "an API route without a session is unauthorized");
assert.deepEqual(await anonymousLive.json(), { error: "Unauthorized" });
assert.equal((await request("anonymous", "/setup")).headers.get("location"), "http://localhost:3000/auth/sign-in", "setup needs a session");

for (const who of ["enrolling", "unfinished"] as const) {
  for (const path of ["/", "/settings", "/inbox"]) {
    const page = await request(who, path);
    assert.equal(page.status, 307, `${who} is sent to setup from ${path}`);
    assert.equal(page.headers.get("location"), "http://localhost:3000/setup");
  }
  const live = await request(who, "/api/live");
  assert.equal(live.status, 403, `${who} gets no API`);
  assert.deepEqual(await live.json(), { error: "Finish setup first" });
  for (const path of ["/setup", "/setup.rsc"]) {
    assert.equal((await request(who, path)).status, 200, `${who} reaches ${path}`);
    assert.equal((await request(who, path, "POST")).status, 200, `${who} can run /setup's server actions`);
  }
  assert.equal((await request(who, "/setupx")).status, 307, "only /setup itself is open");
}

for (const who of ["engineer", "admin"] as const) {
  for (const path of ["/", "/api/live", "/setup", "/settings"]) {
    assert.equal((await request(who, path)).status, 200, `${who} passes through ${path}`);
  }
}

const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const path of ["/", "/api/live", "/setup", "/machines", "/authors", "/auth/settings", "/auth/sign-in-evil", "/auth/sign-up", "/auth/setupx", "/auth/acceptx", "/auth/resetx", "/auth/forbiddenx", "/favicon.icox", "/faviconxico", "/api/authx", "/api/slackx", "/_next/staticx", "/auth/sign-in.evil"]) {
  assert.ok(matcher.test(path), `the proxy guards ${path}`);
}
for (const path of ["/auth/sign-in", "/auth/sign-in/", "/auth/sign-in.rsc", "/auth/sign-in.segments/_tree.segment.rsc", "/auth/setup", "/auth/accept", "/auth/reset", "/auth/forbidden", "/api/auth/sign-in/email", "/api/slack/interactions", "/api/slack/commands", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
  assert.ok(!matcher.test(path), `the proxy lets ${path} through without a session`);
}

// The link pages load without a session and refuse a bad token.
for (const page of ["setup", "accept", "reset"] as const) {
  signInAs("anonymous");
  const { default: Page } = await import(`../app/auth/${page}/page`);
  const html = JSON.stringify(await Page({ searchParams: Promise.resolve({ token: "no-such-token" }) }));
  assert.match(html, /This link is invalid or used/, `/auth/${page} refuses an unknown token`);
}

for (const who of ["anonymous", "enrolling"] as const) {
  signInAs(who);
  await assert.rejects(assertMember(), /Sign in to Hive first/, `the member check refuses ${who}`);
}
signInAs("engineer");
await assertMember();
await assert.rejects(assertAdmin(), /Only an admin/, "an engineer is not an admin");
signInAs("admin");
await assertAdmin();

const { load, runJob, runsQuery } = await import("../lib/live-queries");
const { GET: live } = await import("../app/api/live/route");
const openLive = () => {
  const abort = new AbortController();
  return { abort, response: live(new Request("http://localhost:3000/api/live", { signal: abort.signal })) };
};
signInAs("enrolling");
await assert.rejects(openLive().response, /Sign in to Hive first/, "a user without TOTP gets no live stream");
await assert.rejects(load(runsQuery()), /Sign in to Hive first/, "a user without TOTP gets no rows");
for (const who of ["anonymous", "enrolling"] as const) {
  signInAs(who);
  await assert.rejects(runJob("no-such-session"), /Sign in to Hive first/, `the job lookup refuses ${who}`);
}
signInAs("engineer");
assert.deepEqual(await runJob("no-such-session"), { jobKey: undefined, jobId: undefined }, "a member can look up a run's job");
const stream = openLive();
const opened = await stream.response;
assert.equal(opened.status, 200, "a member gets the live stream");
assert.equal(opened.headers.get("content-type"), "text/event-stream");
assert.equal(opened.headers.get("cache-control"), "no-store");
const { db } = await import("../db/client");
const { sql } = await import("drizzle-orm");
const reader = opened.body!.getReader();
let received = "";
for (let i = 0; i < 2 && !received.includes("data: jobs"); i++) {
  // The first read is the stream's opening comment, sent once it listens.
  if (i === 1) await db.execute(sql`select pg_notify('hive_changes', 'jobs')`);
  received += new TextDecoder().decode((await reader.read()).value);
}
assert.match(received, /^data: jobs$/m, "a change is forwarded as the table's name");
stream.abort.abort();
assert.equal((await reader.read()).done, true, "closing the request ends the stream");

console.log("proxy regressions passed");
process.exit(0);
