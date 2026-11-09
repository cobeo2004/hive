import "./test-guard";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

// The contract for R2's rollout step: lib/rollout.ts exports
//   waitForPanel(url: string, opts: { timeoutMs: number; everyMs: number }): Promise<void>
// It resolves once GET url answers 200, and rejects (naming the URL) when timeoutMs passes first.
// A refused connection or any other status counts as not ready yet.
const { waitForPanel } = await import("../lib/rollout");

const listen = async (server: Server) => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/auth/sign-in`;
};
const close = (server: Server) => {
  server.closeAllConnections();
  return new Promise((resolve) => server.close(resolve));
};

let answers: number[] = [];
const server = createServer((_, res) => res.writeHead(answers.shift() ?? 200).end());
const url = await listen(server);
try {
  answers = [];
  await waitForPanel(url, { timeoutMs: 2_000, everyMs: 50 });

  answers = [503, 502, 404];
  await waitForPanel(url, { timeoutMs: 2_000, everyMs: 50 });
  assert.equal(answers.length, 0, "it keeps asking until the panel answers 200");

  answers = Array(1_000).fill(503);
  const started = Date.now();
  await assert.rejects(waitForPanel(url, { timeoutMs: 300, everyMs: 50 }), (error: Error) => error.message.includes(url), "a panel that never answers 200 fails, naming the URL");
  assert.ok(Date.now() - started < 2_000, "the wait gives up near its timeout");
} finally {
  await close(server);
}

const closed = createServer((_, res) => res.end());
const closedUrl = await listen(closed);
await close(closed);
await assert.rejects(waitForPanel(closedUrl, { timeoutMs: 300, everyMs: 50 }), "a refused connection is not ready");

console.log("panel-ready regressions passed");
