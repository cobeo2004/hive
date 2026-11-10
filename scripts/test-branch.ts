import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { Client } from "pg";
import { identityOf, TEST_DB_ENV, TEST_IDENTITY_ENV } from "../lib/test-mode";

const EXPIRES_AFTER_MS = 2 * 3_600_000;
const NAME = /^hive_test_[a-z0-9_]+$/;
const scriptsDir = import.meta.dirname;
const server = process.env.TEST_DATABASE_URL;
if (!server) throw new Error("set TEST_DATABASE_URL to a Postgres database whose role may CREATE DATABASE, e.g. postgres://localhost/postgres");

function spawnInherit(command: string, args: string[], env: NodeJS.ProcessEnv) {
  return new Promise<number>((resolve) => {
    const child = spawn(command, args, { env, stdio: "inherit" });
    child.on("close", (code) => resolve(code ?? 1));
  });
}

async function maintenance<T>(work: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: server });
  await client.connect();
  try {
    return await work(client);
  } finally {
    await client.end();
  }
}

const only = process.argv.slice(2);
const scripts = readdirSync(scriptsDir)
  .filter((f) => f.endsWith("-regressions.ts") && (only.length === 0 || only.some((name) => f.startsWith(name))))
  .sort();
if (scripts.length === 0) throw new Error(`no regression script matches ${only.join(", ")}`);

const stamp = new Date().toISOString().replace(/\D/g, "").slice(0, 12);
const name = `hive_test_${stamp}_${randomBytes(3).toString("hex")}`;
if (!NAME.test(name)) throw new Error(`bad test database name ${name}`);

// A killed run leaves its database behind; the UTC minute in its name stands in for an expiry.
const createdAt = (db: string) => {
  const [, y, mo, d, h, mi] = /^hive_test_(\d{4})(\d\d)(\d\d)(\d\d)(\d\d)_/.exec(db) ?? [];
  return y ? Date.UTC(+y, +mo! - 1, +d!, +h!, +mi!) : NaN;
};

let dropped = false;
async function dropDatabase() {
  if (dropped) return;
  dropped = true;
  await maintenance((client) => client.query(`drop database if exists "${name}" with (force)`));
  console.log(`dropped test database ${name}`);
}
for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => void dropDatabase().finally(() => process.exit(130)));
}

const failed: string[] = [];
try {
  await maintenance(async (client) => {
    const { rows } = await client.query<{ datname: string }>("select datname from pg_database where datname like 'hive\\_test\\_%' and pg_get_userbyid(datdba) = current_user");
    // Only this role's own: on a shared server another role's stale database can't be dropped, and is theirs to sweep.
    for (const { datname } of rows) {
      if (!NAME.test(datname) || !(Date.now() - createdAt(datname) > EXPIRES_AFTER_MS)) continue;
      await client.query(`drop database if exists "${datname}" with (force)`);
      console.log(`swept stale test database ${datname}`);
    }
    await client.query(`create database "${name}"`);
  });
  console.log(`created test database ${name}`);
  const url = new URL(server);
  url.pathname = `/${name}`;
  const env = {
    ...process.env,
    DATABASE_URL: url.href,
    DATABASE_URL_UNPOOLED: url.href,
    [TEST_DB_ENV]: name,
    [TEST_IDENTITY_ENV]: identityOf(url.href),
  };
  if ((await spawnInherit("bunx", ["drizzle-kit", "migrate"], env)) !== 0) throw new Error("migrating the test database failed");
  for (const script of scripts) {
    console.log(`\n== ${script}`);
    if ((await spawnInherit("bun", [join("scripts", script)], env)) !== 0) failed.push(script);
  }
} finally {
  await dropDatabase();
}
console.log(failed.length ? `\nFAILED: ${failed.join(", ")}` : `\nall ${scripts.length} regression scripts passed`);
process.exit(failed.length ? 1 : 0);
