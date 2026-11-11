import "./test-guard";
import assert from "node:assert/strict";
import { Client } from "pg";

// Every table the panel and runner follow notifies `hive_changes` with its own name once per statement that
// changed rows, and stays quiet for a statement that changed none.
const TABLES = ["jobs", "runs", "agents", "events", "intents", "machines", "job_evidence", "audit_log", "device_frames"];

const listener = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
const writer = new Client({ connectionString: process.env.DATABASE_URL_UNPOOLED });
await Promise.all([listener.connect(), writer.connect()]);
const heard: string[] = [];
const hears = async (table: string, ms: number) => {
  const deadline = Date.now() + ms;
  while (!heard.includes(table) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 20));
  return heard.includes(table);
};
try {
  listener.on("notification", (n) => {
    if (n.channel === "hive_changes" && n.payload) heard.push(n.payload);
  });
  await listener.query("LISTEN hive_changes");

  // Each followed table carries the insert, update and delete triggers.
  const { rows } = await writer.query<{ table: string; n: string }>(
    `select c.relname as table, count(*) as n from pg_trigger t join pg_class c on c.oid = t.tgrelid
     where t.tgname in ('hive_notify_insert', 'hive_notify_update', 'hive_notify_delete') group by c.relname`,
  );
  for (const table of TABLES) assert.equal(rows.find((r) => r.table === table)?.n, "3", `${table} has the three hive_notify triggers`);
  for (const table of ["device_viewers", "job_media"]) assert.ok(!rows.some((r) => r.table === table), `${table} has no hive_notify trigger`);

  // A statement that matches no rows notifies nothing.
  for (const table of TABLES) {
    heard.length = 0;
    await writer.query(`delete from "${table}" where false`);
    assert.ok(!(await hears(table, 300)), `a zero-row write to ${table} does not notify`);
  }

  // The runner's closeBroadcast on a broadcast still waiting for receipts is a zero-row UPDATE like this one.
  heard.length = 0;
  await writer.query("update intents set handled_at = now() where id = 'no-such-intent'");
  assert.ok(!(await hears("intents", 300)), "a zero-row update of intents does not notify");

  // Insert, update and delete of a real row each notify.
  const id = `live-notify-${Date.now()}`;
  for (const [what, statement] of [
    ["insert", `insert into intents (id, kind, created_at) values ('${id}', 'recheck_conflicts', now())`],
    ["update", `update intents set attempts = attempts + 1 where id = '${id}'`],
    ["delete", `delete from intents where id = '${id}'`],
  ] as const) {
    heard.length = 0;
    await writer.query(statement);
    assert.ok(await hears("intents", 2_000), `an ${what} that changes a row notifies hive_changes with "intents" within 2 s`);
  }
} finally {
  await Promise.all([listener.end(), writer.end()]);
}
console.log("live-notify regressions passed");
