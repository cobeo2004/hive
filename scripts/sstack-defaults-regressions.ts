import "./test-guard";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inArray } from "drizzle-orm";

const { db } = await import("../db/client");
const { sstackDefaults } = await import("../db/schema");
const { parseHeartbeat } = await import("../lib/machine");
const { collectHeartbeat, systemCollectors } = await import("../runner/heartbeat");
const { defaultsDeps, defaultsStatus, saveDefaults, syncDefaults } = await import("../runner/sstack-defaults");

const IDS = ["factory", "stray-defaults-regress"];
const root = mkdtempSync(join(tmpdir(), "hive-defaults-regress-"));
const sstack = join(root, "home", ".sstack");
defaultsDeps.home = join(root, "home");
defaultsDeps.dir = join(root, "tmp");
mkdirSync(defaultsDeps.dir);

const put = (path: string, text: string) => {
  mkdirSync(dirname(join(sstack, path)), { recursive: true });
  writeFileSync(join(sstack, path), text);
};
// Regular files only, as {relative path: text}; symlinks are not followed, so a `loop -> .` link cannot recurse.
const snapshot = (dir: string, at = ""): Record<string, string> =>
  Object.assign(
    {},
    ...readdirSync(join(dir, at), { withFileTypes: true }).map((entry) => {
      const path = join(at, entry.name);
      return entry.isDirectory() ? snapshot(dir, path) : entry.isFile() ? { [path]: readFileSync(join(dir, path), "utf8") } : {};
    }),
  );
const rows = () => db.select().from(sstackDefaults).where(inArray(sstackDefaults.id, IDS));
const row = async () => (await rows()).find((r) => r.id === "factory");
const seed = (id: string, files: Record<string, string>, sha: string) =>
  db.insert(sstackDefaults).values({ id, files, sha, updated_at: new Date("2026-11-01T00:00:00Z"), updated_by: "seed@example.com" });

// A fake doctor: any file containing BAD fails it. It always runs against the directory SSTACK_HOME names.
let doctorCalls = 0;
let doctorCwd = "";
let beforeDoctor: (() => void) | undefined; // runs once, after the runner's writes and before doctor answers
defaultsDeps.doctor = async (cwd, env) => {
  doctorCalls++;
  beforeDoctor?.();
  beforeDoctor = undefined;
  doctorCwd = cwd;
  assert.equal(env.SSTACK_HOME, cwd, "doctor reads the directory it is run in");
  const bad = Object.values(snapshot(cwd)).some((text) => text.includes("BAD"));
  return bad ? { code: 1, output: "doctor: bad role" } : { code: 0, output: "ok" };
};

const LOCAL = "workflow = 'local'\n\n[overnight]\nmax = 3\n";
const GOOD = { "config.toml": "workflow = 'hive'\n", "roles/a.toml": "name = 'a'\n", "steps/plan/step.toml": "id = 'plan'\n" };
const collector = systemCollectors(async () => ({ max: 1, inFlight: 0 })).sstackDefaults!;
const beat = async () =>
  parseHeartbeat(
    await collectHeartbeat({
      cpu: async () => "unknown",
      memory: async () => "unknown",
      disk: async () => "unknown",
      capacity: async () => "unknown",
      sstackDefaults: collector,
    }),
  );

await db.delete(sstackDefaults).where(inArray(sstackDefaults.id, IDS));
try {
  put("config.toml", LOCAL);
  put("roles/old.toml", "name = 'old'\n");

  // No row: nothing is written and the heartbeat has nothing to report.
  assert.deepEqual(await syncDefaults(), { skipped: "no defaults" });
  assert.equal(defaultsStatus(), undefined);
  assert.equal((await beat())?.sstackDefaults, "unknown", "no status yet is unknown");
  assert.equal(doctorCalls, 0);

  // 1. A change doctor refuses leaves the row as it was and fails with doctor's output.
  await seed("factory", { "roles/a.toml": "name = 'a'\n" }, "seed");
  const seeded = await row();
  await assert.rejects(
    saveDefaults({ files: { "roles/a.toml": "name = 'BAD'\n" }, by: "me@example.com" }),
    /sstack-doctor failed \(exit 1\):\ndoctor: bad role/,
  );
  assert.deepEqual(await row(), seeded, "the row is unchanged");
  assert.equal(existsSync(doctorCwd), false, "the temporary copy is removed");
  assert.deepEqual(snapshot(sstack), { "config.toml": LOCAL, "roles/old.toml": "name = 'old'\n" }, "the real ~/.sstack is untouched by a save");

  // 2. An accepted change stores {files, sha}; a bad path or an [overnight] table is refused before doctor runs.
  await db.delete(sstackDefaults).where(inArray(sstackDefaults.id, IDS));
  const calls = doctorCalls;
  const sha = createHash("sha256")
    .update(
      JSON.stringify([
        ["config.toml", GOOD["config.toml"]],
        ["roles/a.toml", GOOD["roles/a.toml"]],
        ["steps/plan/step.toml", GOOD["steps/plan/step.toml"]],
      ]),
    )
    .digest("hex");
  assert.deepEqual(await saveDefaults({ files: GOOD, by: "me@example.com" }), { sha });
  assert.equal(doctorCalls, calls + 1);
  assert.equal(existsSync(doctorCwd), false);
  const saved = (await row())!;
  assert.deepEqual([saved.files, saved.sha, saved.updated_by], [GOOD, sha, "me@example.com"]);
  await seed("stray-defaults-regress", { "roles/stray.toml": "name = 'stray'\n" }, "stray");
  const refused: Record<string, string>[] = [
    {},
    { "../x.toml": "a = 1\n" },
    { "roles/../../x.toml": "a = 1\n" },
    { "/etc/passwd": "a = 1\n" },
    { "": "a = 1\n" },
    { "hooks/x.sh": "echo hi\n" },
    { "roles/a.toml": 1 as unknown as string },
    { "config.toml": "[overnight]\nmax = 9\n" },
  ];
  for (const files of refused) {
    await assert.rejects(saveDefaults({ files, by: "me@example.com" }), Error, JSON.stringify(files));
  }
  assert.equal(doctorCalls, calls + 1, "a refused save never reaches doctor");
  assert.deepEqual(await row(), saved, "refused saves leave the row alone");

  // 3. A tick syncs the files, keeps this runner's [overnight], and the second tick writes nothing.
  assert.deepEqual((await syncDefaults()).written?.sort(), Object.keys(GOOD));
  assert.equal(doctorCalls, calls + 2);
  assert.deepEqual(snapshot(sstack), {
    "config.toml": "workflow = 'hive'\n\n[overnight]\nmax = 3\n",
    "roles/a.toml": GOOD["roles/a.toml"],
    "roles/old.toml": "name = 'old'\n",
    "steps/plan/step.toml": GOOD["steps/plan/step.toml"],
  });
  assert.deepEqual(defaultsStatus(), { sha }, "the stray row is ignored");
  const epoch = new Date(1_000_000);
  for (const path of Object.keys(GOOD)) utimesSync(join(sstack, path), epoch, epoch);
  assert.deepEqual(await syncDefaults(), { written: [] });
  assert.equal(doctorCalls, calls + 2, "nothing changed, so no doctor");
  for (const path of Object.keys(GOOD)) assert.equal(statSync(join(sstack, path)).mtimeMs, epoch.getTime(), `${path} was not rewritten`);
  assert.deepEqual((await beat())?.sstackDefaults, { sha });

  // 4. Doctor refuses on the runner: the old files come back byte for byte and the heartbeat carries the error.
  const old = snapshot(sstack);
  const bad = { "config.toml": "workflow = 'BAD'\n", "roles/new.toml": "name = 'new'\n", "roles/a.toml": "name = 'a2'\n" };
  await db
    .update(sstackDefaults)
    .set({ files: bad, sha: "bad-sha" })
    .where(inArray(sstackDefaults.id, ["factory"]));
  assert.deepEqual(await syncDefaults(), { failed: "bad-sha" });
  assert.deepEqual(snapshot(sstack), old, "the previous files are back");
  const status = defaultsStatus();
  assert.match((status as { error: string }).error, /sstack-doctor failed \(exit 1\):\ndoctor: bad role/);
  assert.deepEqual((await beat())?.sstackDefaults, status, "the heartbeat carries the error");
  const failedCalls = doctorCalls;
  assert.deepEqual(await syncDefaults(), { skipped: "failed" });
  assert.equal(doctorCalls, failedCalls, "the same bad sha is not retried");
  await db
    .update(sstackDefaults)
    .set({ files: { ...GOOD, "roles/a.toml": "name = 'a3'\n" }, sha: "fixed-sha" })
    .where(inArray(sstackDefaults.id, ["factory"]));
  assert.deepEqual((await syncDefaults()).written, ["roles/a.toml"], "a new sha is tried again");
  assert.deepEqual(defaultsStatus(), { sha: "fixed-sha" });

  // 5. A file that cannot be put back does not stop the rest, and the sha still counts as failed.
  const a = join(sstack, "roles/a.toml");
  const aBefore = readFileSync(a, "utf8");
  const stuck = { ...GOOD, "roles/a.toml": "name = 'BAD'\n", "roles/n.toml": "name = 'n'\n" };
  await db
    .update(sstackDefaults)
    .set({ files: stuck, sha: "stuck-sha" })
    .where(inArray(sstackDefaults.id, ["factory"]));
  beforeDoctor = () => chmodSync(a, 0o444); // a was written; now it cannot be rewritten
  const stuckCalls = doctorCalls;
  try {
    assert.deepEqual(await syncDefaults(), { failed: "stuck-sha" }, "a failed restore does not throw");
    assert.equal(existsSync(join(sstack, "roles/n.toml")), false, "the other file was still put back");
    const error = (defaultsStatus() as { error: string }).error;
    assert.match(error, /sstack-doctor failed \(exit 1\):\ndoctor: bad role/);
    assert.match(error, /\(could not restore roles\/a\.toml\)$/);
    assert.deepEqual((await beat())?.sstackDefaults, { error });
    assert.deepEqual(await syncDefaults(), { skipped: "failed" });
    assert.equal(doctorCalls, stuckCalls + 1, "the bad sha is not retried");
  } finally {
    chmodSync(a, 0o644);
    writeFileSync(a, aBefore);
  }

  // 6. A symlink below ~/.sstack is never written through, by a save or by a tick, and nothing is rewritten for it.
  const outside = join(root, "outside");
  mkdirSync(outside);
  const target = join(outside, "role.toml");
  writeFileSync(target, "outside\n");
  const old6 = new Date(1_000_000);
  utimesSync(target, old6, old6);
  symlinkSync(target, join(sstack, "roles/link.toml"));
  symlinkSync(outside, join(sstack, "steps/linked"));
  const untouched = () => {
    assert.deepEqual(snapshot(outside), { "role.toml": "outside\n" }, "the outside target is unchanged");
    assert.equal(statSync(target).mtimeMs, old6.getTime(), "the outside target was not even rewritten");
  };
  for (const path of ["roles/link.toml", "steps/linked/step.toml"]) {
    const before6 = await row();
    await assert.rejects(saveDefaults({ files: { [path]: "name = 'x'\n" }, by: "me@example.com" }), /is a symlink/);
    assert.deepEqual(await row(), before6, "the row is unchanged");
    untouched();
  }
  for (const [sha6, path] of [
    ["link-sha", "roles/link.toml"],
    ["dir-sha", "steps/linked/step.toml"],
  ] as const) {
    await db
      .update(sstackDefaults)
      .set({ files: { ...GOOD, "roles/a.toml": "name = 'a6'\n", [path]: "name = 'x'\n" }, sha: sha6 })
      .where(inArray(sstackDefaults.id, ["factory"]));
    assert.deepEqual(await syncDefaults(), { failed: sha6 });
    untouched();
    assert.equal(readFileSync(a, "utf8"), aBefore, "nothing else was written either");
    const error = (defaultsStatus() as { error: string }).error;
    assert.match(error, /is a symlink/);
    assert.deepEqual((await beat())?.sstackDefaults, { error });
  }
  unlinkSync(join(sstack, "roles/link.toml"));
  unlinkSync(join(sstack, "steps/linked"));

  // 7. An unrelated `loop -> .` link does not stop a valid save.
  symlinkSync(".", join(sstack, "loop"));
  assert.deepEqual(await saveDefaults({ files: GOOD, by: "me@example.com" }), { sha });
  unlinkSync(join(sstack, "loop"));

  // 8. ~/.sstack itself a symlink (dotfiles): a tick writes into the real directory.
  const real = join(root, "dotfiles-sstack");
  renameSync(sstack, real);
  symlinkSync(real, sstack);
  await db
    .update(sstackDefaults)
    .set({ files: { ...GOOD, "roles/a.toml": "name = 'a8'\n" }, sha: "root-sha" })
    .where(inArray(sstackDefaults.id, ["factory"]));
  assert.deepEqual(await syncDefaults(), { written: ["roles/a.toml"] });
  assert.equal(readFileSync(join(real, "roles/a.toml"), "utf8"), "name = 'a8'\n", "written into the real directory");
  assert.deepEqual(defaultsStatus(), { sha: "root-sha" });
} finally {
  await db.delete(sstackDefaults).where(inArray(sstackDefaults.id, IDS));
  rmSync(root, { recursive: true, force: true });
}
console.log("sstack-defaults regressions passed");
process.exit(0);
