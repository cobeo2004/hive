import "./test-guard";
import assert from "node:assert/strict";
import { sql } from "drizzle-orm";

// More setup acceptances at once than the pool has connections (5) must not deadlock it, and still make one admin.
const { db } = await import("../db/client");
const { createLink, acceptSetup } = await import("../lib/access-links");

const reset = async () => {
  await db.execute(sql`delete from access_links`);
  await db.execute(sql`delete from "user"`);
};
await reset();
try {
  const tokens = await Promise.all(Array.from({ length: 8 }, () => createLink("setup", null, 3_600_000)));
  const attempts = Promise.allSettled(
    tokens.map((token, i) => acceptSetup(token, { name: `S${i}`, email: `s${i}@unibuz.com.au`, password: "correct horse battery staple 42" })),
  );
  const timeout = new Promise<"hung">((resolve) => setTimeout(() => resolve("hung"), 15_000).unref());
  const results = await Promise.race([attempts, timeout]);
  if (results === "hung") {
    // A deadlocked pool can't run the cleanup either; the harness drops the test database.
    console.error("eight setup acceptances at once deadlocked the pool");
    process.exit(1);
  }
  assert.equal((results as PromiseSettledResult<unknown>[]).filter((r) => r.status === "fulfilled").length, 1, "exactly one makes the admin");
  const admins = (await db.execute<{ n: string }>(sql`select count(*) as n from "user" where role = 'admin'`)).rows[0]!.n;
  assert.equal(Number(admins), 1);
} finally {
  await reset();
}
console.log("setup-lock regressions passed");
process.exit(0);
