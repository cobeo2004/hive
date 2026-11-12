import "./test-guard";
import assert from "node:assert/strict";
import { eq, like } from "drizzle-orm";
import type { PrFacts } from "../lib/merge-decision";

// Bugbot off unless detected: a new repo doesn't wait for a Bugbot it may not have; its first Bugbot review turns the wait on.
const { db } = await import("../db/client");
const { intents, repoSettings } = await import("../db/schema");
const { writeNewRepository } = await import("../lib/repo-onboarding");
const { writeRepository } = await import("../lib/repositories");
const { parseDetail } = await import("../lib/onboarding");
const { DEFAULT_POLICY } = await import("../lib/merge-decision");
const { watchBugbot } = await import("../runner/merge-decision");

const NS = `bugbot-watch-${Date.now()}`;
const [A, B] = [`${NS}/a`, `${NS}/b`];
const policy = { ...DEFAULT_POLICY, autonomy: "auto" as const, requireBugbot: false };
const seen: Pick<PrFacts, "bugbot"> = { bugbot: { review: { state: "reviewed" }, findings: [] } };
const none: Pick<PrFacts, "bugbot"> = { bugbot: { review: { state: "pending" }, findings: [] } };
const row = async (repo: string) => (await db.select().from(repoSettings).where(eq(repoSettings.repo, repo)))[0]!;
const choice = (repo: string, requireBugbot: boolean) => ({
  repo,
  displayName: repo.split("/")[1]!,
  enabled: true,
  provider: null,
  execution: null,
  autonomy: "auto" as const,
  requireBugbot,
});

try {
  await writeNewRepository(db, A, "test", new Date());
  const added = await row(A);
  assert.deepEqual([added.require_bugbot, parseDetail(added.onboarding_detail).bugbotWatch], [false, true], "a new repo starts off and watching");

  assert.equal(await watchBugbot(A, policy, none), policy, "no Bugbot run yet: nothing changes");
  const skipped: Pick<PrFacts, "bugbot"> = { bugbot: { review: { state: "failed", conclusion: "skipped" }, findings: [] } };
  assert.equal(await watchBugbot(A, policy, skipped), policy, "a skipped run is not a review");
  assert.equal((await row(A)).require_bugbot, false);

  assert.deepEqual(await watchBugbot(A, policy, seen), { ...policy, requireBugbot: true }, "the PR that revealed Bugbot waits for it too");
  const turned = await row(A);
  assert.deepEqual([turned.require_bugbot, parseDetail(turned.onboarding_detail).bugbotWatch], [true, undefined], "on, and the watch ends");
  // A second PR of the repo in the same pass still holds the policy read before the first turned it on.
  assert.deepEqual(await watchBugbot(A, policy, seen), { ...policy, requireBugbot: true }, "the second PR waits for Bugbot too");

  // An admin's own choice ends the watch: Bugbot seen later doesn't overrule turning it off by hand.
  await writeNewRepository(db, B, "test", new Date());
  await writeRepository(db, choice(B, false), "test", new Date());
  assert.equal(parseDetail((await row(B)).onboarding_detail).bugbotWatch, true, "saving without touching Require Bugbot keeps the watch");
  await writeRepository(db, choice(B, true), "test", new Date());
  await writeRepository(db, choice(B, false), "test", new Date());
  assert.equal(parseDetail((await row(B)).onboarding_detail).bugbotWatch, undefined, "changing it by hand ends the watch");
  assert.equal(await watchBugbot(B, policy, seen), policy, "so Bugbot's review leaves it off");
  assert.equal((await row(B)).require_bugbot, false);
} finally {
  await db.delete(intents).where(like(intents.detail, `${NS}/%`));
  await db.delete(repoSettings).where(like(repoSettings.repo, `${NS}/%`));
}

console.log("bugbot watch regressions pass");
process.exit(0);
