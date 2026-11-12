/**
 * Wakes a plugin call waiting on a person's answer, when the answer reaches
 * the same isolate that runs the call. Other isolates fall back to the
 * waiter's backed-off polling, so this only saves time and D1 reads.
 */
const waiters = new Map<string, () => void>();

/** Resolves after `ms`, or sooner when the prompt is answered here. */
export const waitForPromptAnswer = (id: string, ms: number) =>
  new Promise<void>((resolve) => {
    const done = () => {
      clearTimeout(timer);
      if (waiters.get(id) === done) waiters.delete(id);
      resolve();
    };
    const timer = setTimeout(done, ms);
    waiters.set(id, done);
  });

export const wakePromptWaiter = (id: string) => waiters.get(id)?.();

/**
 * The pause before the next check: 750 ms for the first 30 seconds, while a
 * person is likely looking at the prompt, then backing off to five seconds.
 */
export const promptPollDelay = (waitedMs: number) =>
  waitedMs < 30_000
    ? 750
    : Math.min(750 * 1.5 ** ((waitedMs - 30_000) / 2_000 + 1), 5_000);
