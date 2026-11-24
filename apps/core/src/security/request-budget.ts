/**
 * Fixed-window request budgets kept in D1 (migration 0235), so every isolate
 * counts against the same budget. A key's count restarts when its window
 * does; rows of windows over a day old are dropped as budgets are taken.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RequestBudget {
  readonly maximum: number;
  /** At most a day. */
  readonly windowMs: number;
}

/** Spends one request of the key's budget; false when none is left. */
export const takeRequestBudget = async (
  db: D1Database,
  key: string,
  budget: RequestBudget,
  now = Date.now(),
) => {
  const windowStartedAt = now - (now % budget.windowMs);
  const [, taken] = await db.batch<{ request_count: number }>([
    db
      .prepare("DELETE FROM request_budget WHERE window_started_at < ?")
      .bind(now - DAY_MS),
    db
      .prepare(
        `INSERT INTO request_budget (key, window_started_at, request_count)
         VALUES (?, ?, 1)
         ON CONFLICT (key) DO UPDATE SET
           request_count = CASE
             WHEN window_started_at < excluded.window_started_at THEN 1
             ELSE request_count + 1
           END,
           window_started_at = MAX(window_started_at, excluded.window_started_at)
         WHERE window_started_at < excluded.window_started_at
            OR request_count < ?
         RETURNING request_count`,
      )
      .bind(key, windowStartedAt, budget.maximum),
  ]);
  return (taken?.results.length ?? 0) > 0;
};
