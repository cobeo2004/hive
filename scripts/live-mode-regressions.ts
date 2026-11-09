import "./test-guard";
import assert from "node:assert/strict";

const OWNER = "owner@example.com";

async function liveUpdatesFor(vercelEnv: string | undefined) {
  if (vercelEnv === undefined) delete process.env.VERCEL_ENV;
  else process.env.VERCEL_ENV = vercelEnv;
  const { default: config } = await import(`../next.config.ts?env=${vercelEnv}`);
  return (config as { env: Record<string, string> }).env.NEXT_PUBLIC_LIVE_UPDATES;
}
assert.equal(await liveUpdatesFor("preview"), "off", "a preview build turns live updates off");
assert.equal(await liveUpdatesFor("production"), "on", "a production build keeps live updates");
assert.equal(await liveUpdatesFor(undefined), "on", "a local build keeps live updates");
delete process.env.VERCEL_ENV;

process.env.NEXT_PUBLIC_LIVE_UPDATES = "off";
const { liveUpdates } = await import("../lib/live-mode");
assert.equal(liveUpdates, false, "the panel reads the build's switch");
const { session } = await import("../lib/auth/server");
Object.assign(session, { read: async () => ({ user: { email: OWNER, role: "engineer", twoFactorEnabled: true } }) });
const { load, runsQuery } = await import("../lib/live-queries");
const feed = await load(runsQuery());
assert.ok(Array.isArray(feed.initialData), "with live updates off, a page still shows the rows");

console.log("live mode regressions passed");
process.exit(0);
