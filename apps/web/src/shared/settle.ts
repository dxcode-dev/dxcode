/** The outcome of an async action, so a caller can clean up without `finally`. */
export type Settled<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: unknown };

/**
 * Runs `action` and returns its outcome instead of throwing. The React
 * Compiler skips any component or hook that contains `try`/`finally`, so
 * handlers settle the action, then run their cleanup on both paths.
 */
export const settle = async <T>(
  action: () => T | PromiseLike<T>,
): Promise<Settled<T>> => {
  try {
    return { ok: true, value: await action() };
  } catch (error) {
    return { ok: false, error };
  }
};
