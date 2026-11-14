/**
 * Cloudflare runs at most four Dynamic Worker invocations at once per
 * request; a fifth fails at once with "Dynamic worker concurrency limit
 * exceeded". Fan-outs over a Thread's plugins (describing them, sending an
 * event to each) go through `mapPluginsLimited`, which keeps them under it
 * with one slot to spare for the request's own call.
 */

/** Plugin invocations one fan-out keeps in flight. */
export const PLUGIN_FAN_OUT = 3;

/** Maps `items` with at most `limit` calls in flight; results keep order. */
export const mapPluginsLimited = async <A, B>(
  items: ReadonlyArray<A>,
  run: (item: A) => Promise<B>,
  limit = PLUGIN_FAN_OUT,
): Promise<B[]> => {
  const results = new Array<B>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await run(items[index] as A);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
};

/** Whether an error is the per-request Dynamic Worker concurrency limit. */
export const isDynamicWorkerConcurrencyLimit = (error: unknown) =>
  error instanceof Error &&
  /dynamic worker concurrency limit/i.test(error.message);

/**
 * Runs `invoke` again while the per-request Dynamic Worker limit refuses
 * it: the refusal comes before the plugin's code starts, so trying again
 * runs nothing twice. Waits up to about three seconds in all for a slot.
 */
export const retryOnDynamicWorkerLimit = async <A>(
  invoke: () => Promise<A>,
): Promise<A> => {
  for (const pause of [50, 100, 200, 400, 800, 1_600]) {
    try {
      return await invoke();
    } catch (error) {
      if (!isDynamicWorkerConcurrencyLimit(error)) throw error;
      await new Promise((resolve) => setTimeout(resolve, pause));
    }
  }
  return invoke();
};
