import assert from "node:assert/strict";
import type { BoardCard } from "../components/panel/cards";
import { isPrReady, prNumber } from "../components/panel/run-card";

type Card = Pick<BoardCard, "stage" | "evidence">;
const green: NonNullable<Card["evidence"]> = { text: "Verified at abc1234 · 3/3 checks", tone: "success" };

// R25c: lime marks a card at `pr` with every check green, and nothing else.
assert.equal(isPrReady({ stage: "pr", evidence: green }), true, "pr with every check green is ready");
const notReady: [Card, string][] = [
  [{ stage: "pr", evidence: { ...green, tone: "destructive" } }, "pr with failing checks is not ready"],
  [{ stage: "pr", evidence: { ...green, tone: "warning" } }, "pr with unverified checks is not ready"],
  [{ stage: "pr", evidence: { ...green, tone: "muted" } }, "pr with muted evidence is not ready"],
  [{ stage: "pr", evidence: null }, "pr without evidence is not ready"],
  [{ stage: "merged", evidence: green }, "merged is not ready"],
  [{ stage: "verifying", evidence: green }, "verifying is not ready"],
  [{ stage: "waiting", evidence: green }, "waiting is not ready"],
];
for (const [card, why] of notReady) assert.equal(isPrReady(card), false, why);

assert.equal(prNumber("https://github.com/unibuz/api/pull/1309"), "#1309", "a pull URL gives its number");
assert.equal(prNumber("https://github.com/unibuz/api/pull/1309/files"), "#1309", "a tab under the pull URL gives its number");
for (const url of ["not a url", null, "https://github.com/unibuz/api/issues/4", "https://github.com/unibuz/api/pull/abc"]) {
  assert.equal(prNumber(url), null, `${JSON.stringify(url)} has no PR number`);
}

console.log("jobs-lime regressions passed");
