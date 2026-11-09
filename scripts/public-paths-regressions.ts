import "./test-guard";
import assert from "node:assert/strict";

// The public paths need no session: the proxy lets them through, and each handler checks its own secret or signature.
process.env.FACTORY_INGEST_SECRET = "ingest-secret-for-regressions";
process.env.LINEAR_WEBHOOK_SECRET = "linear-secret-for-regressions";
process.env.GITHUB_APP_WEBHOOK_SECRET = "github-secret-for-regressions";
process.env.SLACK_SIGNING_SECRET = "slack-secret-for-regressions";

const { config } = await import("../proxy");
const matcher = new RegExp(`^${config.matcher[0]}$`);
for (const path of ["/api/ingest", "/api/webhooks/linear", "/api/webhooks/github", "/api/slack/interactions"]) {
  assert.ok(!matcher.test(path), `the proxy lets ${path} through without a session`);
}
for (const path of ["/api/ingestx", "/api/webhooksx/linear", "/api/live", "/api/live/x"]) {
  assert.ok(matcher.test(path), `the proxy guards ${path}`);
}

const post = (path: string, headers: Record<string, string> = {}) =>
  new Request(`http://localhost:3000${path}`, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: "{}" });

const ingest = await import("../app/api/ingest/route");
for (const headers of [{}, { authorization: "Bearer wrong" }] as Record<string, string>[]) {
  const response = await ingest.POST(post("/api/ingest", headers));
  assert.equal(response.status, 401, `ingest without the secret is unauthorized (${JSON.stringify(headers)})`);
}

const webhooks = await import("../app/api/webhooks/[source]/route");
for (const source of ["linear", "github"]) {
  const response = await webhooks.POST(post(`/api/webhooks/${source}`), { params: Promise.resolve({ source }) });
  assert.equal(response.status, 401, `an unsigned ${source} webhook is unauthorized`);
}
const unknown = await webhooks.POST(post("/api/webhooks/nope"), { params: Promise.resolve({ source: "nope" }) });
assert.equal(unknown.status, 404, "an unknown webhook source is not found");

const slack = await import("../app/api/slack/interactions/route");
const unsigned = await slack.POST(post("/api/slack/interactions"));
assert.equal(unsigned.status, 401, "an unsigned Slack interaction is unauthorized");

console.log("public-paths regressions passed");
