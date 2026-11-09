import "./test-guard";
import assert from "node:assert/strict";

const { keepListening } = await import("../runner/realtime");

// A LISTEN connection the test ends or fails at will, as pg's Client does with `error` and `end`.
class FakeConnection {
  closed = false;
  constructor(readonly onClose: (reason: string) => void) {}
  close() {
    this.closed = true;
  }
}

const connections: FakeConnection[] = [];
const timers: { run: () => void; ms: number }[] = [];
const logged: Record<string, unknown>[] = [];
let failListen = false;
const listening = keepListening({
  listen: async (onClose) => {
    if (failListen) throw new Error("connect ECONNREFUSED");
    const connection = new FakeConnection(onClose);
    connections.push(connection);
    return connection;
  },
  log: (detail) => void logged.push(detail),
  schedule: (run, ms) => void timers.push({ run, ms }),
});
const fire = async () => {
  timers.shift()!.run();
  await new Promise((resolve) => setImmediate(resolve));
};

await listening.start();
assert.equal(connections.length, 1, "start opens one connection");
assert.ok(logged.some((l) => l.status === "live"), "a listening connection is logged live");

// The connection ends: it is closed and replaced after a backoff.
connections[0]!.onClose("ended");
assert.equal(connections[0]!.closed, true, "the ended connection is closed");
assert.deepEqual(timers.map((t) => t.ms), [5_000], "an end schedules one restart");
connections[0]!.onClose("Connection terminated unexpectedly");
assert.equal(timers.length, 1, "a second close from the same connection schedules nothing more");
await fire();
assert.equal(connections.length, 2, "the restart listens on a new connection");

// Failed restarts back off; a live connection resets the backoff.
failListen = true;
connections[1]!.onClose("ended");
assert.equal(timers[0]!.ms, 5_000, "the first failure after a live connection waits the base delay");
await fire();
assert.equal(timers[0]!.ms, 10_000, "a connect that fails waits longer");
await fire();
assert.equal(timers[0]!.ms, 20_000, "and longer again");
failListen = false;
await fire();
assert.equal(connections.length, 3);
connections[2]!.onClose("ended");
assert.equal(timers[0]!.ms, 5_000, "a live connection resets the backoff");
await fire();
assert.ok(logged.some((l) => l.status === "restarting" && String(l.reason).includes("ECONNREFUSED")), "a restart is logged with its cause");

listening.close();
assert.equal(connections.at(-1)!.closed, true, "close closes the current connection");
connections.at(-1)!.onClose("ended");
assert.equal(timers.length, 0, "nothing restarts after close");

console.log("realtime regressions passed");
