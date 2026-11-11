import "./test-guard";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { eq, inArray } from "drizzle-orm";

const { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } = fs;
const { db } = await import("../db/client");
const { sstackDefaults } = await import("../db/schema");
const { parseHeartbeat } = await import("../lib/machine");
const { collectHeartbeat, systemCollectors } = await import("../runner/heartbeat");
const { defaultsDeps, defaultsStatus, saveDefaults, syncDefaults } = await import("../runner/sstack-defaults");

type Files = Record<string, string>;
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
const snapshot = (dir: string, at = ""): Files =>
  Object.assign(
    {},
    ...readdirSync(join(dir, at), { withFileTypes: true }).map((entry) => {
      const path = join(at, entry.name);
      return entry.isDirectory() ? snapshot(dir, path) : entry.isFile() ? { [path]: readFileSync(join(dir, path), "utf8") } : {};
    }),
  );
const factory = eq(sstackDefaults.id, "factory");
const row = async () => (await db.select().from(sstackDefaults).where(factory))[0];
const clean = () => db.delete(sstackDefaults).where(inArray(sstackDefaults.id, IDS));
const seed = (id: string, files: Files, sha: string) =>
  db.insert(sstackDefaults).values({ id, files, sha, updated_at: new Date("2026-11-01T00:00:00Z"), updated_by: "seed@example.com" });
const setRow = (files: Files, sha: string) => db.update(sstackDefaults).set({ files, sha }).where(factory);
const save = (files: Files) => saveDefaults({ files, by: "me@example.com" });
const epoch = new Date(1_000_000);
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
  return Object.values(snapshot(cwd)).some((text) => text.includes("BAD")) ? { code: 1, output: "doctor: bad role" } : { code: 0, output: "ok" };
};
const LOCAL = "workflow = 'local'\n\n[overnight]\nmax = 3\n";
const OLD = "name = 'old'\n";
const GOOD = { "config.toml": "workflow = 'hive'\n", "roles/a.toml": "name = 'a'\n", "steps/plan/step.toml": "id = 'plan'\n" };
const unknown = async () => "unknown" as const;
const collectors = { cpu: unknown, memory: unknown, disk: unknown, capacity: unknown, sstackDefaults: systemCollectors(unknown).sstackDefaults! };
const beat = async () => (parseHeartbeat(await collectHeartbeat(collectors)) as { sstackDefaults: unknown }).sstackDefaults;
/** A tick on a row doctor or a link refuses: it fails, and the heartbeat carries the same error. Returns the error. */
const failedTick = async (files: Files, sha: string) => {
  await setRow(files, sha);
  assert.deepEqual(await syncDefaults(), { failed: sha });
  const { error } = defaultsStatus() as { error: string };
  assert.deepEqual(await beat(), { error });
  return error;
};
const DOCTOR = /sstack-doctor failed \(exit 1\):\ndoctor: bad role/;
const notRetried = async () => {
  doctorCalls = 0;
  assert.deepEqual(await syncDefaults(), { skipped: "failed" });
  assert.equal(doctorCalls, 0, "the same bad sha is not retried");
};
await clean();
try {
  put("config.toml", LOCAL);
  put("roles/old.toml", OLD);
  // No row: nothing is written and the heartbeat has nothing to report.
  assert.deepEqual(await syncDefaults(), { skipped: "no defaults" });
  assert.equal(defaultsStatus(), undefined);
  assert.equal(await beat(), "unknown");

  // 1. A change doctor refuses leaves the row as it was and fails with doctor's output.
  await seed("factory", { "roles/a.toml": "name = 'a'\n" }, "seed");
  const seeded = await row();
  await assert.rejects(save({ "roles/a.toml": "name = 'BAD'\n" }), DOCTOR);
  assert.deepEqual(await row(), seeded);
  assert.equal(existsSync(doctorCwd), false, "the temporary copy is removed");
  assert.deepEqual(snapshot(sstack), { "config.toml": LOCAL, "roles/old.toml": OLD }, "the real ~/.sstack is untouched by a save");

  // 2. An accepted change stores {files, sha} (checked against an independent sha256); bad paths and [overnight] never reach doctor.
  await clean();
  doctorCalls = 0;
  const sha = createHash("sha256")
    .update(JSON.stringify(Object.entries(GOOD)))
    .digest("hex");
  assert.deepEqual(await save(GOOD), { sha });
  assert.equal(doctorCalls, 1);
  const saved = (await row())!;
  assert.deepEqual([saved.files, saved.sha, saved.updated_by], [GOOD, sha, "me@example.com"]);
  await seed("stray-defaults-regress", { "roles/stray.toml": "name = 'stray'\n" }, "stray");
  const refused: Files[] = [{}, { "../x.toml": "a = 1\n" }, { "roles/../../x.toml": "a = 1\n" }, { "/etc/passwd": "a = 1\n" }, { "": "a = 1\n" }];
  refused.push({ "hooks/x.sh": "echo hi\n" }, { "roles/a.toml": 1 as unknown as string }, { "config.toml": "[overnight]\nmax = 9\n" });
  for (const files of refused) await assert.rejects(save(files), Error, JSON.stringify(files));
  assert.equal(doctorCalls, 1, "a refused save never reaches doctor");
  assert.deepEqual(await row(), saved, "refused saves leave the row alone");

  // 3. A tick syncs the files and keeps this runner's [overnight]; the second tick writes nothing and the stray row is ignored.
  assert.deepEqual((await syncDefaults()).written?.sort(), Object.keys(GOOD));
  assert.equal(doctorCalls, 2);
  assert.deepEqual(snapshot(sstack), { ...GOOD, "config.toml": `${GOOD["config.toml"]}\n[overnight]\nmax = 3\n`, "roles/old.toml": OLD });
  for (const path of Object.keys(GOOD)) utimesSync(join(sstack, path), epoch, epoch);
  assert.deepEqual(await syncDefaults(), { written: [] });
  assert.equal(doctorCalls, 2, "nothing changed, so no doctor");
  for (const path of Object.keys(GOOD)) assert.equal(statSync(join(sstack, path)).mtimeMs, epoch.getTime(), `${path} was not rewritten`);
  assert.deepEqual(await beat(), { sha });

  // 4. Doctor refuses on the runner: the old files come back byte for byte, the heartbeat carries the error, the bad sha is not retried.
  const old = snapshot(sstack);
  assert.match(
    await failedTick({ "config.toml": "workflow = 'BAD'\n", "roles/new.toml": "name = 'new'\n", "roles/a.toml": "name = 'a2'\n" }, "bad-sha"),
    DOCTOR,
  );
  assert.deepEqual(snapshot(sstack), old, "the previous files are back");
  await notRetried();
  await setRow({ ...GOOD, "roles/a.toml": "name = 'a3'\n" }, "fixed-sha");
  assert.deepEqual((await syncDefaults()).written, ["roles/a.toml"], "a new sha is tried again");

  // 5. A file that cannot be put back does not stop the rest, and the sha still counts as failed.
  const a = join(sstack, "roles/a.toml");
  const aBefore = readFileSync(a, "utf8");
  beforeDoctor = () => chmodSync(a, 0o444); // a was written; now it cannot be rewritten
  const error = await failedTick({ ...GOOD, "roles/a.toml": "name = 'BAD'\n", "roles/n.toml": "name = 'n'\n" }, "stuck-sha");
  assert.match(error, DOCTOR);
  assert.match(error, /\(could not restore roles\/a\.toml\)$/);
  assert.equal(existsSync(join(sstack, "roles/n.toml")), false, "the other file was still put back");
  await notRetried();
  chmodSync(a, 0o644);
  writeFileSync(a, aBefore);
  // 6. A symlinked file or directory below ~/.sstack is never written through, by a save or by a tick, nor even rewritten.
  const outside = join(root, "outside");
  const target = join(outside, "role.toml");
  mkdirSync(outside);
  writeFileSync(target, "outside\n");
  utimesSync(target, epoch, epoch);
  for (const [linkSha, link, to, path] of [
    ["link-sha", "roles/link.toml", target, "roles/link.toml"],
    ["dir-sha", "steps/linked", outside, "steps/linked/step.toml"],
  ] as const) {
    symlinkSync(to, join(sstack, link));
    const before = await row();
    await assert.rejects(save({ [path]: "name = 'x'\n" }), /is a symlink/);
    assert.deepEqual(await row(), before, "the row is unchanged");
    assert.match(await failedTick({ ...GOOD, "roles/a.toml": "name = 'a6'\n", [path]: "name = 'x'\n" }, linkSha), /is a symlink/);
    assert.deepEqual(snapshot(outside), { "role.toml": "outside\n" });
    assert.equal(statSync(target).mtimeMs, epoch.getTime(), "the outside target was not even rewritten");
    assert.equal(readFileSync(a, "utf8"), aBefore, "nothing else was written either");
    rmSync(join(sstack, link));
  }

  // 7. An unrelated `loop -> .` link does not stop a valid save.
  symlinkSync(".", join(sstack, "loop"));
  assert.deepEqual(await save(GOOD), { sha });
  rmSync(join(sstack, "loop"));

  // 8. ~/.sstack itself a symlink (dotfiles): a tick writes into the real directory.
  const real = join(root, "dotfiles-sstack");
  renameSync(sstack, real);
  symlinkSync(real, sstack);
  await setRow({ ...GOOD, "roles/a.toml": "name = 'a8'\n" }, "root-sha");
  assert.deepEqual(await syncDefaults(), { written: ["roles/a.toml"] });
  assert.equal(readFileSync(join(real, "roles/a.toml"), "utf8"), "name = 'a8'\n", "written into the real directory");
} finally {
  await clean();
  rmSync(root, { recursive: true, force: true });
}
console.log("sstack-defaults regressions passed");
process.exit(0);
