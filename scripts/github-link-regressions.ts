import "./test-guard";
import assert from "node:assert/strict";
import { eq } from "drizzle-orm";

const { db } = await import("../db/client");
const { user } = await import("../db/schema");
const { pollLink, startLink, unlink } = await import("../lib/github-link");

// R27f: the device flow with a stubbed GitHub. Only login and id are stored; the token never is.
const stamp = Date.now();
const TOKEN = `gho_fake_${stamp}`;
const ids = [`gh-link-${stamp}-a`, `gh-link-${stamp}-b`];
const calls: { url: string; body?: string; auth?: string | null }[] = [];
let tokenReply: object = { error: "authorization_pending", interval: 5 };
const fetchFake = (async (url: string, init: RequestInit = {}) => {
  calls.push({ url, body: init.body as string | undefined, auth: new Headers(init.headers).get("authorization") });
  if (url.endsWith("/login/device/code"))
    return Response.json({
      device_code: "dev-code-secret",
      user_code: "ABCD-1234",
      verification_uri: "https://github.com/login/device",
      expires_in: 900,
      interval: 5,
    });
  if (url.endsWith("/login/oauth/access_token")) return Response.json(tokenReply);
  if (url.endsWith("/user")) return Response.json({ id: stamp, login: "dana-private" });
  throw new Error(`unexpected ${url}`);
}) as unknown as typeof fetch;
let now = 1_000_000;
const deps = { db, clientId: "Iv1.fake", secret: "fake-auth-secret", fetch: fetchFake, now: () => now };

try {
  await db.insert(user).values(ids.map((id) => ({ id, name: id, email: `${id}@example.com` })));
  const started = await startLink(deps, ids[0]!);
  assert.ok(started, "a code comes back");
  assert.deepEqual([started.userCode, started.verificationUri], ["ABCD-1234", "https://github.com/login/device"]);
  assert.equal(JSON.parse(calls[0]!.body!).client_id, "Iv1.fake", "the App's client id asks");
  assert.ok(
    !started.handle.includes("dev-code-secret") && !Buffer.from(started.handle, "base64url").toString().includes("dev-code-secret"),
    "the device code is sealed",
  );

  assert.deepEqual(await pollLink(deps, ids[0]!, started.handle), { status: "pending", interval: 5 }, "waiting on the user");
  assert.equal(JSON.parse(calls.at(-1)!.body!).device_code, "dev-code-secret", "the server polls with the device code");
  tokenReply = { error: "slow_down", interval: 10 };
  assert.deepEqual(await pollLink(deps, ids[0]!, started.handle), { status: "pending", interval: 10, slowDown: true }, "slow_down backs off");
  tokenReply = { error: "access_denied" };
  assert.deepEqual(await pollLink(deps, ids[0]!, started.handle), { status: "denied" }, "a refused code is denied");
  tokenReply = { error: "unsupported_grant_type" };
  assert.deepEqual(await pollLink(deps, ids[0]!, started.handle), { status: "failed" }, "other errors fail");
  assert.deepEqual(await pollLink(deps, ids[1]!, started.handle), { status: "failed" }, "another user's handle is refused");
  assert.deepEqual(await pollLink(deps, ids[0]!, `${started.handle.slice(0, -4)}AAAA`), { status: "failed" }, "a tampered handle is refused");

  tokenReply = { access_token: TOKEN, token_type: "bearer" };
  const linked = await pollLink(deps, ids[0]!, started.handle);
  assert.deepEqual(linked, { status: "linked", login: "dana-private" }, "linked, and no token in the outcome");
  assert.equal(calls.at(-1)!.auth, `Bearer ${TOKEN}`, "the token read /user once");
  const [row] = await db.select().from(user).where(eq(user.id, ids[0]!));
  assert.deepEqual([row!.githubId, row!.githubLogin], [stamp, "dana-private"], "login and id stored");
  assert.ok(!JSON.stringify(row).includes(TOKEN), "the token is not on the user");

  // The same GitHub account for a second Hive user is refused by the unique id.
  const other = await startLink(deps, ids[1]!);
  assert.deepEqual(await pollLink(deps, ids[1]!, other!.handle), { status: "taken" });

  now += 901_000;
  assert.deepEqual(await pollLink(deps, ids[1]!, other!.handle), { status: "expired" }, "an expired handle is not polled");

  await unlink(db, ids[0]!);
  const [cleared] = await db.select().from(user).where(eq(user.id, ids[0]!));
  assert.deepEqual([cleared!.githubId, cleared!.githubLogin], [null, null], "unlink clears both");
  console.log("github link regressions passed");
} finally {
  for (const id of ids) await db.delete(user).where(eq(user.id, id));
}
process.exit(0);
