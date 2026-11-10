import "./test-guard";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

// The contract for R32: setup token, invites and resets are one-time, hashed, expiring links.
// lib/access-links.ts exports:
//   createLink(kind: "setup" | "invite" | "reset", email: string | null, ttlMs: number): Promise<string>  (the raw token)
//   consumeLink(kind, token): Promise<{ email: string | null }>  (throws when unknown, used, expired or the wrong kind)
//   acceptSetup(token, { name, email, password }): Promise<{ id: string }>  (creates the first admin)
//   acceptInvite(token, { name, password }): Promise<{ id: string }>  (creates an engineer with the invited email)
const { db } = await import("../db/client");
const { createLink, consumeLink, acceptSetup, acceptInvite } = await import("../lib/access-links");

async function reset() {
  await db.execute(sql`delete from access_links`);
  await db.execute(sql`delete from "user"`);
}
const count = async (where: ReturnType<typeof sql>) =>
  Number((await db.execute<{ n: string }>(sql`select count(*) as n from "user" where ${where}`)).rows[0]!.n);
const PASSWORD = "correct horse battery staple 42";

await reset();
try {
  // Only the hash is stored.
  const token = await createLink("invite", "a@unibuz.com.au", 60_000);
  const stored = await db.execute<{ token_hash: string }>(sql`select token_hash from access_links`);
  assert.equal(stored.rows.length, 1);
  assert.ok(!stored.rows[0]!.token_hash.includes(token), "the raw token is never stored");

  // A link works once, and only for its kind.
  await assert.rejects(consumeLink("reset", token), "an invite is not a reset link");
  assert.equal((await consumeLink("invite", token)).email, "a@unibuz.com.au");
  await assert.rejects(consumeLink("invite", token), "a used link is refused");
  await assert.rejects(consumeLink("invite", "no-such-token"), "an unknown token is refused");

  // An expired link is refused.
  const expired = await createLink("reset", "a@unibuz.com.au", -1);
  await assert.rejects(consumeLink("reset", expired), "an expired link is refused");

  // Two concurrent consumes of one link: exactly one wins.
  const raced = await createLink("invite", "b@unibuz.com.au", 60_000);
  const results = await Promise.allSettled([consumeLink("invite", raced), consumeLink("invite", raced)]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1, "a link is consumed once under concurrency");

  // Invites are for the company domain only.
  await assert.rejects(createLink("invite", "x@gmail.com", 60_000), /unibuz\.com\.au/, "an invite outside @unibuz.com.au is refused");

  // Two different setup tokens accepted at once make exactly one admin.
  await reset();
  const [one, two] = [await createLink("setup", null, 3_600_000), await createLink("setup", null, 3_600_000)];
  const accepted = await Promise.allSettled([
    acceptSetup(one, { name: "One", email: "one@unibuz.com.au", password: PASSWORD }),
    acceptSetup(two, { name: "Two", email: "two@unibuz.com.au", password: PASSWORD }),
  ]);
  assert.equal(accepted.filter((r) => r.status === "fulfilled").length, 1, "only one setup acceptance succeeds");
  assert.equal(await count(sql`role = 'admin'`), 1, "exactly one admin exists");
  assert.equal(await count(sql`true`), 1, "the losing acceptance created no user");

  // Once an admin exists, setup links can be neither created nor accepted.
  await assert.rejects(createLink("setup", null, 3_600_000), "no setup link once an admin exists");
  const leftover = (await db.execute<{ n: string }>(sql`select count(*) as n from access_links where kind = 'setup' and used_at is null`)).rows[0]!.n;
  assert.ok(Number(leftover) <= 1, "at most the losing token is left unused");
  if (accepted[0]!.status === "rejected") await assert.rejects(acceptSetup(one, { name: "Late", email: "late@unibuz.com.au", password: PASSWORD }));
  else await assert.rejects(acceptSetup(two, { name: "Late", email: "late@unibuz.com.au", password: PASSWORD }));
  assert.equal(await count(sql`role = 'admin'`), 1, "a late setup token makes no second admin");

  // An invite creates an engineer with the invited email, once.
  const invite = await createLink("invite", "eng@unibuz.com.au", 60_000);
  await acceptInvite(invite, { name: "Eng", password: PASSWORD });
  assert.equal(await count(sql`email = 'eng@unibuz.com.au' and role = 'engineer'`), 1, "an invite makes an engineer");
  await assert.rejects(acceptInvite(invite, { name: "Again", password: PASSWORD }), "an invite is accepted once");
} finally {
  await reset();
}
console.log("access-links regressions passed");
process.exit(0);
