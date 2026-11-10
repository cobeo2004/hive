import "./test-guard";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "pg-connection-string";
import { identityOf, TEST_DB_ENV, TEST_IDENTITY_ENV } from "../lib/test-mode";

const NEON = "postgresql://u:p@ep-odd-field-b95xpf9v-pooler.c-2.eu-central-1.aws.neon.tech/neondb?sslmode=require";

assert.equal(identityOf(NEON), "ep-odd-field-b95xpf9v/neondb", "a Neon host is its endpoint and database");
assert.equal(identityOf(NEON), identityOf(NEON.replace("-pooler", "")), "the pooled and direct hosts are one database");
assert.notEqual(identityOf(NEON), identityOf(NEON.replace("/neondb", "/hive_test_x")), "databases on one Neon endpoint differ");
assert.notEqual(identityOf("postgres://db.example.com/a"), identityOf("postgres://db.example.com/b"), "databases on one server differ");
assert.equal(identityOf("postgres://localhost/x"), identityOf("postgres://127.0.0.1:5432/x"), "localhost and 127.0.0.1:5432 are one database");
assert.equal(identityOf("postgres://localhost/x"), identityOf("postgres://[::1]/x"), "::1 is loopback too");
assert.equal(identityOf("postgres://localhost/x"), identityOf("postgres:///x?host=/tmp"), "a unix socket is loopback");
assert.equal(identityOf("postgres://u@/x"), identityOf("postgres://LOCALHOST/X"), "an empty host is loopback, and case is ignored");
assert.notEqual(identityOf("postgres://localhost/x"), identityOf("postgres://localhost:5433/x"), "another port is another server");
assert.equal(identityOf("postgres://u@localhost"), identityOf("postgres://localhost/u"), "no database means the user's database");
assert.throws(() => identityOf("postgres://h/x?hostaddr=192.0.2.1"), /hostaddr/);
assert.throws(() => identityOf("postgres://a,b/x"), /more than one host/);
assert.equal(identityOf("postgres://localhost/x?port=05432"), identityOf("postgres://localhost/x"), "a padded port is the same port");
assert.equal(identityOf("postgres://localhost./x"), identityOf("postgres://localhost/x"), "a trailing dot names the same host");
assert.throws(() => identityOf("postgres://ep-a.neon.tech,ep-a.neon.tech/x"), /more than one host/, "a Neon host list is refused too");

// The guard runs in a child whose cwd holds a fake .env.local, so no real one is needed.
const dir = mkdtempSync(join(tmpdir(), "test-guard-"));
const PRODUCTION = "postgres://postgres@localhost/hive";
const TEST = "postgres://postgres@localhost/hive_test_x";
writeFileSync(join(dir, ".env.local"), `DATABASE_URL=${PRODUCTION}\n`);
function guard(url: string, identity = identityOf(TEST)) {
  const run = spawnSync("bun", [join(import.meta.dirname, "test-guard.ts")], {
    cwd: dir,
    env: { ...process.env, DATABASE_URL: url, DATABASE_URL_UNPOOLED: url, [TEST_DB_ENV]: "hive_test_x", [TEST_IDENTITY_ENV]: identity },
    encoding: "utf8",
  });
  return { code: run.status, stderr: run.stderr };
}
try {
  for (const url of [PRODUCTION, "postgres://postgres@127.0.0.1/hive", "postgres://postgres@localhost:5432/hive"]) {
    const run = guard(url);
    assert.notEqual(run.code, 0, `the guard refuses ${url}`);
    assert.match(run.stderr, /Refusing to run/);
  }
  const claimsProduction = guard(PRODUCTION, identityOf("postgres://127.0.0.1:5432/hive"));
  assert.match(claimsProduction.stderr, /is the one \.env\.local points at/, "a harness identity that is the .env.local database refuses");
  assert.deepEqual(guard(TEST), { code: 0, stderr: "" }, "the test database passes");
} finally {
  rmSync(dir, { recursive: true, force: true });
}

assert.match(parse(process.env.DATABASE_URL!).database ?? "", /^hive_test_[a-z0-9_]+$/, "the harness runs on a hive_test_ database");
console.log("test-db regressions passed");
