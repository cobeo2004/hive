import "./test-guard";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq, inArray } from "drizzle-orm";

// R11a: the 5h and 7d meters of subscription accounts, from recorded provider payloads.
const { db } = await import("../db/client");
const { accountUsage, agentAccounts, user } = await import("../db/schema");
const { newKeyPair, seal } = await import("../lib/creds");
const { parseRollout, readRollouts } = await import("../lib/codex-usage");
const { localHost } = await import("../lib/host");
const { claudeLimits, newestLimits, pollClaudeUsage, recordCodexLimits } = await import("../runner/account-usage");

const pair = newKeyPair();
const env = { HIVE_CREDS_PRIVATE_KEY: pair.privateKey };
const TOKEN = "sk-ant-oat-meter-secret-token";
const U = "usage-user";
const ids = { claude: "usage-claude", claudeKey: "usage-claude-key", codex: "usage-codex", codexKey: "usage-codex-key" };
const account = (id: string, provider: "claude" | "codex", kind: "subscription" | "api_key") => ({
  id,
  owner_id: U,
  provider,
  kind,
  label: id,
  sealed: seal(TOKEN, pair.publicKey),
});
const rows = async (id: string) =>
  (await db.select().from(accountUsage).where(eq(accountUsage.account_id, id))).sort((a, b) => a.window.localeCompare(b.window));
const shape = (r: Awaited<ReturnType<typeof rows>>) => r.map((x) => [x.window, x.used_pct, x.resets_at?.toISOString() ?? null]);

// Recorded from Claude's /api/oauth/usage, and from a Codex rollout's token_count line.
const claudeBody = {
  five_hour: { utilization: 37.5, resets_at: "2026-11-11T09:00:00.000Z" },
  seven_day: { utilization: 12, resets_at: "2026-11-15T00:00:00.000Z" },
  seven_day_opus: null,
};
const rollout = [
  { type: "session_meta", payload: { id: "019a2b3c-0000-7000-8000-0000000000a1", timestamp: "2026-11-11T05:00:00.000Z" } },
  {
    type: "event_msg",
    timestamp: "2026-11-11T05:01:00.000Z",
    payload: {
      type: "token_count",
      info: { total_token_usage: { input_tokens: 10, cached_input_tokens: 0, output_tokens: 5 } },
      rate_limits: { primary: { used_percent: 20, window_minutes: 300, resets_at: 1794380000 }, secondary: null },
    },
  },
  {
    type: "event_msg",
    timestamp: "2026-11-11T05:02:00.000Z",
    payload: {
      type: "token_count",
      info: null,
      rate_limits: {
        primary: { used_percent: 41.0, window_minutes: 300, resets_at: 1794387600 },
        secondary: { used_percent: 9.0, window_minutes: 10080, resets_at: 1794816000 },
      },
    },
  },
]
  .map((l) => JSON.stringify(l))
  .join("\n");
const CLAUDE_ROWS = [
  ["5h", 37.5, "2026-11-11T09:00:00.000Z"],
  ["7d", 12, "2026-11-15T00:00:00.000Z"],
];
const CODEX_ROWS = [
  ["5h", 41, "2026-11-11T09:00:00.000Z"],
  ["7d", 9, "2026-11-16T08:00:00.000Z"],
];

// The pure parts: Claude's body, tolerantly, and the rollout's last limits.
assert.deepEqual(
  claudeLimits({ five_hour: { utilization: 3, resets_at: null }, seven_day: "junk" }),
  { "5h": { usedPct: 3, resetsAt: null } },
  "a null reset and a junk window",
);
assert.deepEqual(claudeLimits("junk"), {});
const parsed = parseRollout(rollout)!;
assert.deepEqual(
  parsed.rateLimits,
  { "5h": { usedPct: 41, resetsAt: 1794387600 }, "7d": { usedPct: 9, resetsAt: 1794816000 } },
  "the last line with limits wins, null info or not",
);
assert.equal(parseRollout(rollout.split("\n").slice(0, 2).join("\n"))!.rateLimits?.["7d"], undefined, "a null window is left out");
assert.equal(parseRollout(rollout.split("\n")[0]!)!.rateLimits, undefined, "no token count, no limits");
assert.equal(parsed.rateLimitsAt, Date.parse("2026-11-11T05:02:00.000Z"), "stamped with the line the limits came from");

// The host command keeps the last line that has limits: a later `"rate_limits":null` must not hide them.
const home = mkdtempSync(join(tmpdir(), "account-usage-"));
mkdirSync(join(home, "sessions/2026/11/11"), { recursive: true });
const nullLimits = JSON.stringify({
  type: "event_msg",
  timestamp: "2026-11-11T05:03:00.000Z",
  payload: { type: "token_count", info: null, rate_limits: null },
});
writeFileSync(join(home, "sessions/2026/11/11/rollout-a.jsonl"), `${rollout}\n${nullLimits}\n`);
const [read] = await readRollouts(localHost, home, Date.now() - 60_000);
assert.deepEqual(read?.rateLimits, parsed.rateLimits, "a null-limits line after valid ones hides nothing");

await db.delete(agentAccounts).where(inArray(agentAccounts.id, Object.values(ids)));
await db.delete(user).where(eq(user.id, U));
await db.insert(user).values({ id: U, name: "Usage", email: "usage@example.com", role: "engineer" });
await db.insert(agentAccounts).values([account(ids.claude, "claude", "subscription"), account(ids.claudeKey, "claude", "api_key")]);
const logged: string[] = [];
const realLog = console.log;
try {
  console.log = (...args: unknown[]) => void logged.push(args.map(String).join(" "));
  // A poll reads the subscription account with its own token, and skips the API-key one.
  const calls: { url: string; auth: string | null }[] = [];
  const ok = async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), auth: new Headers(init?.headers).get("authorization") });
    return Response.json(claudeBody);
  };
  await pollClaudeUsage({ fetch: ok as typeof fetch, env, now: new Date("2026-11-11T06:00:00.000Z") });
  assert.deepEqual(calls, [{ url: "https://api.anthropic.com/api/oauth/usage", auth: `Bearer ${TOKEN}` }], "one call, to the usage endpoint, as the account");
  assert.deepEqual(shape(await rows(ids.claude)), CLAUDE_ROWS);
  assert.equal((await rows(ids.claude))[0]!.read_at.toISOString(), "2026-11-11T06:00:00.000Z");
  assert.deepEqual(await rows(ids.claudeKey), [], "an API-key account has no meters");

  // A later read updates the row in place.
  const next = { ...claudeBody, five_hour: { utilization: 150, resets_at: "2026-11-11T14:00:00.000Z" } };
  await pollClaudeUsage({ fetch: (async () => Response.json(next)) as typeof fetch, env, now: new Date("2026-11-11T07:00:00.000Z") });
  assert.deepEqual(shape(await rows(ids.claude)), [["5h", 100, "2026-11-11T14:00:00.000Z"], CLAUDE_ROWS[1]], "upserted, and clamped to 100");

  // A failed read leaves the rows as they were and never logs the token.
  const before = shape(await rows(ids.claude));
  await pollClaudeUsage({ fetch: (async () => new Response("nope", { status: 500 })) as typeof fetch, env });
  await pollClaudeUsage({
    fetch: (async () => {
      throw new Error(`boom ${TOKEN}`);
    }) as typeof fetch,
    env,
  });
  await pollClaudeUsage({ fetch: (async () => new Response("{", { status: 200 })) as typeof fetch, env });
  await pollClaudeUsage({ fetch: ok as typeof fetch, env: {} });
  assert.deepEqual(shape(await rows(ids.claude)), before, "failed reads change nothing");
  assert.equal(logged.filter((l) => l.includes("account-usage:failed")).length, 3, "each failure is logged once");
  assert.ok(
    logged.some((l) => l.includes('"reason":500')),
    "with its status",
  );
  assert.ok(!logged.some((l) => l.includes(TOKEN)), "and never the token");
  console.log = realLog;

  // Codex: the rollout's limits go to a subscription account only.
  await db.insert(agentAccounts).values([account(ids.codex, "codex", "subscription"), account(ids.codexKey, "codex", "api_key")]);
  const at = (hhmm: string) => Date.parse(`2026-11-11T${hhmm}:00.000Z`);
  // A reading with no event time cannot be ordered: it writes no row.
  await recordCodexLimits(ids.codex, parsed.rateLimits!);
  await recordCodexLimits(ids.codex, parsed.rateLimits!, Number.NaN);
  assert.deepEqual(await rows(ids.codex), [], "a reading with no `at` writes nothing");
  await recordCodexLimits(ids.codex, parsed.rateLimits!, at("04:00"));
  await recordCodexLimits(ids.codexKey, parsed.rateLimits!, at("04:00"));
  await recordCodexLimits("usage-gone", parsed.rateLimits!, at("04:00"));
  assert.deepEqual(shape(await rows(ids.codex)), CODEX_ROWS);
  assert.deepEqual(await rows(ids.codexKey), [], "an API-key account has no meters");

  // ...and leaves an existing row unchanged.
  await recordCodexLimits(ids.codex, { "5h": { usedPct: 1, resetsAt: 1794387600 } });
  assert.deepEqual(shape(await rows(ids.codex)), CODEX_ROWS, "a reading with no `at` never overwrites a row");

  // The newest reading wins: an older one never replaces a newer row; a still newer one does.
  await recordCodexLimits(ids.codex, { "5h": { usedPct: 96, resetsAt: 1794387600 } }, at("06:00"));
  await recordCodexLimits(ids.codex, { "5h": { usedPct: 10, resetsAt: 1794387600 } }, at("05:00"));
  assert.equal((await rows(ids.codex))[0]!.used_pct, 96, "an older reading is ignored");
  await recordCodexLimits(ids.codex, { "5h": { usedPct: 12, resetsAt: 1794387600 } }, at("07:00"));
  assert.equal((await rows(ids.codex))[0]!.used_pct, 12, "a newer one replaces it");

  // The newest reading across the root and its subagents is the one recorded.
  const tokenCount = (ts: string, usedPct: number) =>
    JSON.stringify({
      type: "event_msg",
      timestamp: ts,
      payload: { type: "token_count", info: null, rate_limits: { primary: { used_percent: usedPct, window_minutes: 300, resets_at: 1794387600 } } },
    });
  const meta = (id: string) => JSON.stringify({ type: "session_meta", payload: { id, timestamp: "2026-11-11T05:00:00.000Z" } });
  const thread = (id: string, ts?: string, usedPct = 0) => parseRollout([meta(id), ...(ts ? [tokenCount(ts, usedPct)] : [])].join("\n"))!;
  const root = thread("root", "2026-11-11T05:01:00.000Z", 20);
  const sub = thread("sub", "2026-11-11T05:02:00.000Z", 96);
  assert.deepEqual(
    newestLimits([root, sub]),
    { limits: { "5h": { usedPct: 96, resetsAt: 1794387600 } }, at: Date.parse("2026-11-11T05:02:00.000Z") },
    "a newer subagent reading beats the root's",
  );
  assert.equal(newestLimits([sub, root])?.limits["5h"]?.usedPct, 96, "whatever the order");
  assert.equal(newestLimits([thread("root2", "2026-11-11T05:03:00.000Z", 30), sub])?.limits["5h"]?.usedPct, 30, "the root wins when it is newest");
  assert.equal(newestLimits([thread("a"), thread("b")]), undefined, "no limits anywhere, nothing to record");
  await db.delete(accountUsage).where(eq(accountUsage.account_id, ids.codex));
  const newest = newestLimits([root, sub])!;
  await recordCodexLimits(ids.codex, newest.limits, newest.at);
  assert.equal((await rows(ids.codex))[0]!.used_pct, 96, "the row ends at the subagent's 96");
} finally {
  console.log = realLog;
  await db.delete(agentAccounts).where(inArray(agentAccounts.id, Object.values(ids)));
  await db.delete(user).where(eq(user.id, U));
}

console.log("account-usage regressions pass");
process.exit(0);
