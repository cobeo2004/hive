import assert from "node:assert/strict";
import type { BoardCard } from "../components/panel/cards";
import { decisionLine } from "../components/panel/merge-decision";
import { isPrReady, issueRef, prNumber, shortDuration } from "../components/panel/run-card";

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

// The card names the ticket, not the factory's internal key.
const KEY = "GH-cobeo2004-hive-sandbox-h-5a0724945e606c53e460-1";
const ref = (href: string | null) => issueRef({ sourceLink: href ? { label: "x", href } : null, jobKey: KEY, id: "abcdef123456" });
assert.equal(ref("https://github.com/cobeo2004/hive-sandbox/issues/1"), "hive-sandbox #1");
assert.equal(ref("https://linear.app/unibuz/issue/UNI-142/sort-the-list"), "UNI-142");
assert.equal(ref("https://example.com/ticket/9"), KEY, "an unknown tracker keeps the key");
assert.equal(ref(null), KEY);
assert.deepEqual([shortDuration(45_000), shortDuration(5 * 60_000 + 10_000), shortDuration(125 * 60_000)], ["45s", "5m", "2h 5m"]);

// A pending decision says what it waits on.
const pending = (reasons: string[]) => decisionLine({ outcome: "pending", reasons } as unknown as Parameters<typeof decisionLine>[0]).text;
assert.equal(pending(["Waiting for Bugbot."]), "Waiting for Bugbot");
assert.equal(pending(["Waiting for checks, Bugbot."]), "Waiting for checks, Bugbot");
assert.equal(pending([]), "Waiting for checks");

console.log("jobs-lime regressions passed");
