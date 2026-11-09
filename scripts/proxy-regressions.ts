import "./test-guard";
import assert from "node:assert/strict";
import { NextRequest, NextResponse } from "next/server";

const OWNER = "owner@example.com";
process.env.FACTORY_OWNER_EMAILS = OWNER;
process.env.NEON_AUTH_BASE_URL ??= "https://auth.invalid/neondb/auth";
process.env.NEON_AUTH_COOKIE_SECRET ??= "x".repeat(32);

const { auth, assertOwner } = await import("../lib/auth/server");
const REFRESHED = "x-session-refreshed";
Object.assign(auth, {
  middleware: () => async () => NextResponse.next({ headers: { [REFRESHED]: "1" } }),
});
const { proxy, config } = await import("../proxy");

type Who = "anonymous" | "stranger" | "unverified" | "owner";
const SESSIONS: Record<Who, { user: { email: string; emailVerified: boolean } } | null> = {
  anonymous: null,
  stranger: { user: { email: "stranger@example.com", emailVerified: true } },
  unverified: { user: { email: OWNER, emailVerified: false } },
  owner: { user: { email: OWNER.toUpperCase(), emailVerified: true } },
};
function signInAs(who: Who) {
  Object.assign(auth, { getSession: async () => ({ data: SESSIONS[who], error: null }) });
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
assert.equal(anonymousLive.headers.get(REFRESHED), null);

for (const who of ["stranger", "unverified"] as const) {
  const page = await request(who, "/");
  assert.equal(page.status, 403, `a page request from the ${who} account is forbidden`);
  assert.equal(page.headers.get("x-middleware-rewrite"), "http://localhost:3000/auth/forbidden", `the ${who} account sees the forbidden page`);
  assert.equal(page.headers.get(REFRESHED), null);

  const live = await request(who, "/api/live");
  assert.equal(live.status, 403, `an API request from the ${who} account is forbidden`);
  assert.deepEqual(await live.json(), { error: "Forbidden" });
}

for (const path of ["/", "/api/live"]) {
  const response = await request("owner", path);
  assert.equal(response.status, 200, `the owner passes through ${path}`);
  assert.equal(response.headers.get(REFRESHED), "1", `the owner reaches ${path} through the session refresh`);
}

const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const path of ["/", "/api/live", "/machines", "/authors", "/auth/settings", "/auth/sign-in-evil", "/auth/sign-upx", "/auth/forbiddenx", "/favicon.icox", "/faviconxico", "/api/authx", "/api/slackx", "/_next/staticx", "/auth/sign-in.evil"]) {
  assert.ok(matcher.test(path), `the proxy guards ${path}`);
}
for (const path of ["/auth/sign-in", "/auth/sign-in/", "/auth/sign-in.rsc", "/auth/sign-in.segments/_tree.segment.rsc", "/auth/sign-up", "/auth/forbidden", "/api/auth/sign-in/email", "/api/slack/interactions", "/api/slack/commands", "/_next/static/chunk.js", "/_next/image", "/favicon.ico"]) {
  assert.ok(!matcher.test(path), `the proxy lets ${path} through without a session`);
}

for (const who of ["anonymous", "stranger", "unverified"] as const) {
  signInAs(who);
  await assert.rejects(assertOwner(), /owner session is required/, `the owner check refuses ${who}`);
}
const { load, runJob, runsQuery } = await import("../lib/live-queries");
const { GET: live } = await import("../app/api/live/route");
const openLive = () => {
  const abort = new AbortController();
  return { abort, response: live(new Request("http://localhost:3000/api/live", { signal: abort.signal })) };
};
signInAs("unverified");
await assert.rejects(openLive().response, /owner session is required/, "an unverified owner gets no live stream");
await assert.rejects(load(runsQuery()), /owner session is required/, "an unverified owner gets no rows");
for (const who of ["anonymous", "stranger", "unverified"] as const) {
  signInAs(who);
  await assert.rejects(runJob("no-such-session"), /owner session is required/, `the job lookup refuses ${who}`);
}
signInAs("owner");
await assertOwner();
assert.deepEqual(await runJob("no-such-session"), { jobKey: undefined, jobId: undefined }, "the owner can look up a run's job");
const stream = openLive();
const opened = await stream.response;
assert.equal(opened.status, 200, "the verified owner gets the live stream");
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
