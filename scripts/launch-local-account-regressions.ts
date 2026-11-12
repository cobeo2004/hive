import "./test-guard";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";

// R9b: a local job runs on its owner's account through a per-user T3 instance; a Codex account goes to one job at a time and is sealed again on release.
const home = mkdtempSync(join(tmpdir(), "hive-local-account-"));
process.env.HOME = home;
process.env.T3CODE_HOME = join(home, ".t3");

const { db } = await import("../db/client");
const { agentAccounts, jobs, user } = await import("../db/schema");
const { accountFor, newKeyPair, seal, unseal } = await import("../lib/creds");
const { credsDir, localAccounts, materialize, resealLocal } = await import("../runner/local-account");
const { teardownSandbox } = await import("../runner/lifecycle");
const { leaseCodexSlot } = await import("../runner/ops");
const { linearJob } = await import("./fixtures");

const pair = newKeyPair();
const env = { HIVE_CREDS_PRIVATE_KEY: pair.privateKey };
process.env.HIVE_CREDS_PRIVATE_KEY = pair.privateKey; // what teardownSandbox reads
const stamp = Date.now();
const U = `local-acct-${stamp}`;
const keys = { one: `LAC${stamp}-1`, two: `LAC${stamp}-2` };
const AUTH = '{"tokens":{"refresh_token":"r-1"}}';
const REFRESHED = '{"tokens":{"refresh_token":"r-2"}}';
const settings = () => JSON.parse(readFileSync(join(home, ".t3", "userdata", "settings.json"), "utf8"));
const logs: string[] = [];
const log = (event: string, detail: Record<string, unknown>) => logs.push(`${event} ${JSON.stringify(detail)}`);
const real = (account: typeof accountFor = accountFor) =>
  localAccounts({ account: (key, provider) => account(key, provider, undefined, env), lease: (key, marker, slot) => leaseCodexSlot(key, marker, [slot]), log });
const entry = (key: string, provider: string) => ({ key, owner: U, harness: { provider, model: "m" } });

try {
  // Materialising: a Codex login lands in the user's home with the instance pointing at it; Claude's token goes to the instance's environment.
  seedSettings();
  assert.equal(materialize(U, "codex", AUTH), `codex-${U}`);
  const codexFile = join(credsDir(U, "codex"), "auth.json");
  assert.equal(readFileSync(codexFile, "utf8"), AUTH);
  assert.equal(statSync(codexFile).mode & 0o777, 0o600, "auth.json is private");
  assert.equal(materialize(U, "claudeAgent", "claude-token"), `claudeAgent-${U}`);
  const { providerInstances: instances, keep } = settings();
  assert.deepEqual(instances[`codex-${U}`], { driver: "codex", enabled: true, config: { homePath: credsDir(U, "codex") } });
  assert.deepEqual(instances[`claudeAgent-${U}`], {
    driver: "claudeAgent",
    enabled: true,
    environment: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", value: "claude-token" }],
    config: { homePath: credsDir(U, "claude") },
  });
  assert.equal(keep, "other settings survive", "T3's other settings are kept");

  await db.insert(user).values({ id: U, name: U, email: `${U}@example.com` });
  const account = (id: string, provider: "claude" | "codex", text: string) => ({
    id,
    owner_id: U,
    provider,
    kind: "subscription" as const,
    label: id,
    sealed: seal(text, pair.publicKey),
  });
  await db.insert(agentAccounts).values([account(`${U}-claude`, "claude", "own-claude-token"), account(`${U}-codex`, "codex", AUTH)]);
  const pending = (key: string, marker: string) => linearJob(key, key, { owner_id: U, t3_thread_id: marker, machine_id: "local-acct-machine" });
  await db.insert(jobs).values([pending(keys.one, "pending:one"), pending(keys.two, "pending:two")]);

  // A Claude job takes the owner's account and starts on the owner's instance; a harness without a per-user instance keeps the Mac's login.
  const claude = real();
  assert.equal(await claude.pick(entry(keys.one, "claudeAgent")), true);
  assert.equal(await claude.lease(keys.one, "pending:one"), true, "a Claude token is static: nothing to lease");
  assert.deepEqual(claude.harness(entry(keys.one, "claudeAgent")), { provider: `claudeAgent-${U}`, model: "m" });
  assert.equal(await claude.pick(entry(keys.one, "cursor")), true);
  assert.deepEqual(claude.harness(entry(keys.one, "cursor")), { provider: "cursor", model: "m" }, "no account, no instance");
  assert.equal(await claude.pick({ ...entry(keys.one, "claudeAgent"), owner: null }), true, "a job with no owner runs on the Mac's login");
  assert.equal(await real(async () => "wait").pick(entry(keys.one, "claudeAgent")), false, "a full pool leaves the job queued");
  const refused = await real(async () => {
    throw new Error("a sealed credential could not be opened");
  }).pick(entry(keys.one, "claudeAgent"));
  assert.equal(refused, false, "an account that cannot be opened leaves the job queued");

  // Codex: one job at a time. The second waits; the first's release seals the refreshed auth.json and frees the account.
  const first = real();
  const second = real();
  assert.equal(await first.pick(entry(keys.one, "codex")), true);
  assert.equal(await first.lease(keys.one, "pending:one"), true);
  assert.equal(await second.pick(entry(keys.two, "codex")), true);
  assert.equal(await second.lease(keys.two, "pending:two"), false, "the account is leased to the first job");
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, keys.one)))[0]!.codex_slot, `account:${U}-codex`);

  first.harness(entry(keys.one, "codex"));
  writeFileSync(codexFile, REFRESHED);
  const [held] = await db.select().from(jobs).where(eq(jobs.key, keys.one));
  await teardownSandbox(held!);
  const [sealed] = await db
    .select()
    .from(agentAccounts)
    .where(eq(agentAccounts.id, `${U}-codex`));
  assert.equal(unseal(sealed!.sealed, pair.privateKey), REFRESHED, "the refreshed login is sealed again");
  assert.ok(!sealed!.sealed.toString("latin1").includes("r-2"), "and sealed, not plain");
  assert.equal(existsSync(codexFile), false, "the plaintext copy is deleted");
  assert.equal((await db.select().from(jobs).where(eq(jobs.key, keys.one)))[0]!.codex_slot, null, "the lease is released");
  assert.equal(await resealLocal(keys.one, `account:${U}-codex`, env), "missing", "a second release has nothing left to seal");
  assert.equal(await second.pick(entry(keys.two, "codex")), true);
  assert.equal(await second.lease(keys.two, "pending:two"), true, "the next job gets the account");
  second.harness(entry(keys.two, "codex"));
  assert.equal(readFileSync(codexFile, "utf8"), REFRESHED, "and starts from the refreshed login");

  assert.ok(!logs.some((line) => /own-claude-token|claude-token|r-1|r-2/.test(line)), "no log line holds a secret");
} finally {
  await db.delete(jobs).where(inArray(jobs.key, Object.values(keys)));
  await db.delete(agentAccounts).where(eq(agentAccounts.owner_id, U));
  await db.delete(user).where(eq(user.id, U));
}

function seedSettings() {
  // T3's settings already hold something this flow must not drop.
  const dir = join(home, ".t3", "userdata");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "settings.json"),
    JSON.stringify({ keep: "other settings survive", providerInstances: { codex: { driver: "codex", enabled: true } } }),
  );
}

console.log("launch local account regressions pass");
process.exit(0);
