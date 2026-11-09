import "./test-guard";
import assert from "node:assert/strict";
import { Client } from "pg";

// Every table the panel and runner follow notifies `hive_changes` with its own name once per statement.
const TABLES = ["jobs", "runs", "agents", "events", "intents", "machines", "job_evidence", "audit_log"];

const listener = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const writer = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await Promise.all([listener.connect(), writer.connect()]);
try {
  const heard: string[] = [];
  listener.on("notification", (n) => {
    if (n.channel === "hive_changes" && n.payload) heard.push(n.payload);
  });
  await listener.query("LISTEN hive_changes");

  for (const table of TABLES) {
    heard.length = 0;
    // A statement trigger fires even when no row matches, so this proves the trigger without fixture rows.
    await writer.query(`delete from "${table}" where false`);
    const deadline = Date.now() + 2_000;
    while (!heard.includes(table) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
    assert.ok(heard.includes(table), `a write to ${table} notifies hive_changes with "${table}" within 2 s`);
  }
} finally {
  await Promise.all([listener.end(), writer.end()]);
}
console.log("live-notify regressions passed");
