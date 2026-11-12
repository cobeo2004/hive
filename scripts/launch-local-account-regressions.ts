import "./test-guard";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray, like } from "drizzle-orm";
import { fakeModal } from "./fake-modal";

const home = mkdtempSync(join(tmpdir(), "hive-local-account-"));
process.env.HOME = home;
process.env.T3CODE_HOME = join(home, ".t3");

const { db } = await import("../db/client");
const { agentAccounts, jobs, machines, user } = await import("../db/schema");
const { newKeyPair, seal, unseal } = await import("../lib/creds");
const { modal } = await import("../lib/modal-host");
const { credsDir, localAccounts, materialize, sweepLogins } = await import("../runner/local-account");
const { thisMachine } = await import("../runner/heartbeat");
const { reap, teardownSandbox } = await import("../runner/lifecycle");
const { leaseCodexSlot } = await import("../runner/ops");
const { sandboxRuntime } = await import("../runner/sandbox");
const { linearJob } = await import("./fixtures");

modal.api = fakeModal;
const pair = newKeyPair();
process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey; // what the runner reads
const stamp = Date.now();
const [U, V] = [`local-acct-${stamp}`, `local-acct-v-${stamp}`];
const keys = { one: `LAC${stamp}-1`, two: `LAC${stamp}-2`, brief: `LAC${stamp}-3`, over: `LAC${stamp}-4`, dead: `LAC${stamp}-5` };
const AUTH = '{"tokens":{"refresh_token":"r-1"}}';
const REFRESHED = '{"tokens":{"refresh_token":"r-2"}}';
const settingsFile = join(home, ".t3", "userdata", "settings.json");
const settings = () => JSON.parse(readFileSync(settingsFile, "utf8"));
const logs: string[] = [];
const log = (event: string, detail: Record<string, unknown>) => logs.push(`${event} ${JSON.stringify(detail)}`);
sandboxRuntime.log = log; // lifecycle logs here
const real = () => localAccounts({ lease: (key, marker, slot) => leaseCodexSlot(key, marker, [slot]), log });
const entry = (key: string, provider: string, owner = U) => ({ key, owner, harness: { provider, model: "m" } });
const slotOf = async (key: string) => (await db.select().from(jobs).where(eq(jobs.key, key)))[0]!.codex_slot;

try {
  // Materialising: a Codex login lands in its home with the instance pointing at it; Claude's token goes to the instance's environment; an unchanged instance is not rewritten.
  mkdirSync(join(home, ".t3", "userdata"), { recursive: true });
  writeFileSync(settingsFile, JSON.stringify({ keep: "other settings survive", providerInstances: { codex: { driver: "codex", enabled: true } } }));
  assert.equal(materialize(U, "codex", AUTH), `codex-${U}`);
  const codexFile = join(credsDir(U, "codex"), "auth.json");
  assert.equal(statSync(codexFile).mode & 0o777, 0o600, "auth.json is private");
  assert.equal(materialize(U, "claudeAgent", "claude-token"), `claudeAgent-${U}`);
  const { providerInstances: instances, keep } = settings();
  assert.deepEqual(instances[`codex-${U}`], { driver: "codex", enabled: true, config: { homePath: credsDir(U, "codex") } });
  assert.deepEqual(instances[`claudeAgent-${U}`].environment, [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "claude-token" }]);
  assert.equal(keep, "other settings survive", "T3's other settings are kept");
  utimesSync(settingsFile, 1, 1);
  materialize(U, "claudeAgent", "claude-token");
  assert.equal(statSync(settingsFile).mtimeMs, 1000, "settings.json is written only when it changes");

  await db.insert(user).values([U, V].map((id) => ({ id, name: id, email: `${id}@example.com` })));
  const account = (id: string, provider: "claude" | "codex", text: string, pooled = false) => {
    const kind = pooled ? ("api_key" as const) : ("subscription" as const);
    return { id, owner_id: pooled ? null : U, provider, kind, label: id, sealed: seal(text, pair.publicKey) };
  };
  const poolCodex = account(`${U}-pool-codex`, "codex", "pool-codex-key", true);
  await db.insert(agentAccounts).values([account(`${U}-claude`, "claude", "own-claude-token"), account(`${U}-codex`, "codex", AUTH)]);
  await db
    .insert(agentAccounts)
    .values([account(`${U}-pool-claude`, "claude", "pool-claude-key", true), { ...account(`${U}-v-claude`, "claude", "v-key", true), owner_id: V }]);
  const mid = (await thisMachine()).id;
  const pending = (key: string, marker: string) => linearJob(key, key, { owner_id: U, t3_thread_id: marker, machine_id: mid });
  await db.insert(jobs).values([pending(keys.one, "pending:one"), pending(keys.two, "pending:two")]);

  // A Claude job takes the owner's subscription and starts on the owner's instance; a harness without a per-user instance, or an owner with no subscription, keeps the Mac's login.
  const claude = real();
  assert.equal(await claude.pick(entry(keys.one, "claudeAgent")), true);
  assert.equal(await claude.lease(keys.one, "pending:one"), true, "a Claude token is static: nothing to lease");
  assert.deepEqual(claude.harness(entry(keys.one, "claudeAgent")), { provider: `claudeAgent-${U}`, model: "m" });
  assert.equal(await claude.pick(entry(keys.one, "cursor")), true);
  assert.deepEqual(claude.harness(entry(keys.one, "cursor")), { provider: "cursor", model: "m" }, "no account, no instance");
  assert.equal(await claude.pick({ ...entry(keys.one, "claudeAgent"), owner: "" }), true, "a job with no owner runs on the Mac's login");
  assert.equal(await claude.pick(entry(keys.one, "claudeAgent", V)), true);
  assert.deepEqual(claude.harness(entry(keys.one, "claudeAgent", V)), { provider: "claudeAgent", model: "m" }, "an API key is not used locally");
  process.env.HIVE_CREDS_PRIVATE_KEY = newKeyPair().privateKey;
  assert.equal(await real().pick(entry(keys.one, "claudeAgent")), false, "an account that cannot be opened leaves the job queued");
  process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey;

  // Codex: one job at a time. The second waits when no pool account exists, else takes it; the first's release seals the refreshed auth.json and frees the account.
  const first = real();
  const second = real();
  assert.equal(await first.pick(entry(keys.one, "codex")), true);
  assert.equal(await first.lease(keys.one, "pending:one"), true);
  assert.equal(await second.pick(entry(keys.two, "codex")), true);
  assert.equal(await second.lease(keys.two, "pending:two"), false, "the account is leased to the first job and no pool account exists");
  assert.equal(await slotOf(keys.one), `account:${U}-codex`);
  await db.insert(agentAccounts).values([{ ...account(`${U}-pool-sub`, "codex", "not-a-key", true), kind: "subscription" as const }, poolCodex]);
  assert.equal(await second.pick(entry(keys.two, "codex")), true);
  assert.equal(await second.lease(keys.two, "pending:two"), true, "a free pool account beats waiting");
  second.harness(entry(keys.two, "codex"));
  const poolFile = join(credsDir(`pool-${U}-pool-codex`, "codex"), "auth.json");
  assert.equal(readFileSync(poolFile, "utf8"), '{"OPENAI_API_KEY":"pool-codex-key"}', "the pool key is its own login, apart from the owner's");
  second.discard(keys.two);
  assert.equal(existsSync(poolFile), false, "a failed launch leaves no plaintext login");
  second.harness(entry(keys.two, "codex"));
  await teardownSandbox((await db.select().from(jobs).where(eq(jobs.key, keys.two)))[0]!);
  assert.equal(existsSync(poolFile), false, "the pool login is deleted on release");
  assert.equal(
    unseal(
      (
        await db
          .select()
          .from(agentAccounts)
          .where(eq(agentAccounts.id, `${U}-pool-codex`))
      )[0]!.sealed,
      pair.privateKey,
    ),
    "pool-codex-key",
    "a pool key is never rewritten",
  );

  first.harness(entry(keys.one, "codex"));
  writeFileSync(codexFile, REFRESHED);
  await db.update(jobs).set({ t3_thread_id: "thread-one" }).where(eq(jobs.key, keys.one));
  await reap();
  await reap();
  assert.equal(await slotOf(keys.one), `account:${U}-codex`, "reap leaves a live local job's account lease alone");
  await teardownSandbox((await db.select().from(jobs).where(eq(jobs.key, keys.one)))[0]!);
  const [sealed] = await db
    .select()
    .from(agentAccounts)
    .where(eq(agentAccounts.id, `${U}-codex`));
  assert.equal(unseal(sealed!.sealed, pair.privateKey), REFRESHED, "the refreshed login is sealed again");
  assert.ok(!sealed!.sealed.toString("latin1").includes("r-2"), "and sealed, not plain");
  assert.equal(existsSync(codexFile), false, "the plaintext copy is deleted");
  assert.equal(await slotOf(keys.one), null, "the lease is released");
  assert.equal(await second.pick(entry(keys.two, "codex")), true);
  assert.equal(await second.lease(keys.two, "pending:two"), true, "the next job gets the owner's account again");
  second.harness(entry(keys.two, "codex"));
  assert.equal(readFileSync(codexFile, "utf8"), REFRESHED, "and starts from the refreshed login");
  // The owner reconnects while it runs: the job's login grew from an older seal, so it cannot overwrite the new one.
  const RECONNECTED = '{"tokens":{"refresh_token":"r-3"}}';
  await db
    .update(agentAccounts)
    .set({ sealed: seal(RECONNECTED, pair.publicKey) })
    .where(eq(agentAccounts.id, `${U}-codex`));
  writeFileSync(codexFile, '{"tokens":{"refresh_token":"r-4"}}');
  await teardownSandbox((await db.select().from(jobs).where(eq(jobs.key, keys.two)))[0]!);
  const [kept] = await db
    .select()
    .from(agentAccounts)
    .where(eq(agentAccounts.id, `${U}-codex`));
  assert.equal(unseal(kept!.sealed, pair.privateKey), RECONNECTED, "the reconnected login survives");
  assert.equal(existsSync(codexFile), false, "and the stale plaintext is deleted");

  // A machine that stopped reporting keeps its job's account lease (a Mac that sleeps resumes) until the job is over or hours pass; a disconnected account drops its instance (and token) from T3's settings.
  const silent = (name: string, minutes: number) => ({ id: `${U}-${name}`, name, last_seen_at: new Date(Date.now() - minutes * 60_000), heartbeat: {} });
  await db.insert(machines).values([silent("brief", 10), silent("dead", 7 * 60)]);
  const held = (key: string, machine: string, extra = {}) =>
    linearJob(key, key, { owner_id: U, machine_id: `${U}-${machine}`, codex_slot: `account:${U}-${key}`, ...extra });
  await db.insert(jobs).values([held(keys.brief, "brief"), held(keys.over, "brief", { stage: "merged" }), held(keys.dead, "dead")]);
  const { freed } = await reap();
  assert.equal(await slotOf(keys.brief), `account:${U}-${keys.brief}`, "ten silent minutes keep the lease");
  assert.ok(
    [keys.over, keys.dead].every((k) => freed.includes(k)),
    "a finished job's lease, and one silent for hours, are freed",
  );
  assert.ok(
    logs.some((line) => line.startsWith("local:lease-freed") && line.includes("reconnecting")),
    "and the log says the account may need reconnecting",
  );
  await db
    .update(agentAccounts)
    .set({ disconnected_at: new Date() })
    .where(eq(agentAccounts.id, `${U}-claude`));
  assert.equal(await real().pick(entry(keys.one, "claudeAgent")), true);
  assert.equal(`claudeAgent-${U}` in settings().providerInstances, false, "the disconnected Claude token is gone");
  assert.ok(`codex-${U}` in settings().providerInstances && settings().keep, "while the rest of the settings stay");

  mkdirSync(join(tmpdir(), "hive-login-crashed"), { recursive: true });
  sweepLogins();
  assert.equal(existsSync(join(tmpdir(), "hive-login-crashed")), false, "runner start sweeps the temp homes a crashed login left");
  assert.ok(!logs.some((line) => /own-claude-token|claude-token|r-1|r-2|pool-codex-key/.test(line)), "no log line holds a secret");
} finally {
  await db.delete(jobs).where(inArray(jobs.key, Object.values(keys)));
  await db.delete(machines).where(like(machines.id, `${U}%`));
  await db.delete(agentAccounts).where(like(agentAccounts.id, `${U}-%`));
  await db.delete(user).where(inArray(user.id, [U, V]));
}

console.log("launch local account regressions pass");
process.exit(0);
