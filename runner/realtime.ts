export type Listening = { close(): void };

export type KeepListeningDeps = {
  /** Connects and LISTENs; `onClose` runs when that connection errors or ends. */
  listen: (onClose: (reason: string) => void) => Promise<Listening>;
  log: (detail: Record<string, unknown>) => void;
  schedule: (run: () => void, ms: number) => void;
};

/**
 * Keeps the runner listening for table changes. A connection that fails, errors or ends is closed and
 * replaced, with backoff, until one is listening again; a live connection resets the backoff. The
 * tick stays the real loop, so a gap only delays work until the next tick.
 */
export function keepListening(deps: KeepListeningDeps, { baseMs = 5_000, capMs = 60_000 } = {}) {
  let current: Listening | undefined;
  let generation = 0;
  let failures = 0;
  let closed = false;

  const restart = (gen: number, reason: string) => {
    if (closed || gen !== generation) return;
    generation += 1;
    current?.close();
    current = undefined;
    const delayMs = Math.min(baseMs * 2 ** failures, capMs);
    failures += 1;
    deps.log({ status: "restarting", delayMs, reason });
    deps.schedule(() => void start(), delayMs);
  };

  async function start() {
    if (closed) return;
    const gen = generation;
    let listening: Listening;
    try {
      listening = await deps.listen((reason) => restart(gen, reason));
    } catch (error) {
      restart(gen, String(error));
      return;
    }
    // Closed, or the connection already ended while it was being set up.
    if (gen !== generation) return listening.close();
    current = listening;
    failures = 0;
    deps.log({ status: "live" });
  }

  return {
    start,
    close() {
      closed = true;
      generation += 1;
      current?.close();
      current = undefined;
    },
  };
}
