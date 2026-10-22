/**
 * Ended browser sessions, as this isolate sees them.
 *
 * Better Auth answers a warm signed cookie cache without reading D1, so a
 * deleted session row alone cannot stop a browser that still holds one.
 * Migration 0081 records every deleted session in `session_revocation` for
 * the cache max age, and Better Auth asks `sessionCacheVersion` on every
 * cache hit (better-auth.ts). Each isolate reads new records at most once
 * per `sessionRevocationWindowMs`, so a cache hit costs no D1 read while the
 * isolate's view is fresh.
 */

/**
 * Better Auth's cookie cache max age. Migration 0081's trigger prunes records
 * after 3600000 ms, so raising this needs a migration that recreates the
 * trigger; session-revocation.test.ts fails while the two disagree.
 */
export const sessionCookieCacheMaxAgeSeconds = 60 * 60;

/**
 * The longest an ended session keeps working from a warm cookie cache. The
 * isolate that ends a session through Better Auth sees it at once.
 */
export const sessionRevocationWindowMs = 5_000;

const retainedMs = sessionCookieCacheMaxAgeSeconds * 1000;
/** Re-read this far behind the newest record, in case D1's clock stepped back. */
const clockSlackMs = 60_000;
/** A waiter abandons a shared read after this and reads for itself. */
const readTimeoutMs = 2_000;

const ended = new Map<string, number>();
/** The newest `ended_at` read, on D1's clock. */
let readThrough = 0;
let readAt = Number.NEGATIVE_INFINITY;
let reading: Promise<void> | undefined;

const readEnded = async (db: D1Database) => {
  const startedAt = Date.now();
  const { results } = await db
    .prepare(
      `SELECT session_id, ended_at FROM session_revocation
       WHERE ended_at >= max(?, CAST(unixepoch('subsec') * 1000 AS INTEGER) - ?)`,
    )
    .bind(readThrough - clockSlackMs, retainedMs)
    .all<{ session_id: string; ended_at: number }>();
  for (const row of results) {
    ended.set(row.session_id, row.ended_at);
    readThrough = Math.max(readThrough, row.ended_at);
  }
  for (const [sessionId, endedAt] of ended) {
    if (endedAt < startedAt - retainedMs - clockSlackMs)
      ended.delete(sessionId);
  }
  readAt = startedAt;
};

const timedOut = (milliseconds: number) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), milliseconds);
  });
  return { promise, cancel: () => clearTimeout(timer) };
};

/**
 * Refreshes the view when older than `maxAgeMs`. Concurrent requests share
 * one read, but a request cancelled mid-read can leave it pending forever, so
 * a waiter gives up on another request's read after `readTimeoutMs`, drops
 * it, and reads itself. A failed read fails the request.
 */
const refresh = async (db: D1Database, maxAgeMs: number): Promise<void> => {
  const age = Date.now() - readAt;
  // A clock that stepped back makes the last read look newer than it is.
  if (age >= 0 && age < maxAgeMs) return;
  const shared = reading;
  if (shared !== undefined) {
    const timeout = timedOut(readTimeoutMs);
    try {
      if ((await Promise.race([shared, timeout.promise])) !== "timeout") return;
    } finally {
      timeout.cancel();
    }
    if (reading === shared) reading = undefined;
  }
  const read = readEnded(db).finally(() => {
    if (reading === read) reading = undefined;
  });
  reading ??= read;
  await read;
};

/**
 * Whether the session ended; fails when the record cannot be read. The view
 * is read again when older than `maxAgeMs`; a WebSocket holder that checks
 * on its own schedule passes 0 so its schedule alone bounds the delay.
 */
export const sessionEnded = async (
  db: D1Database,
  sessionId: string,
  maxAgeMs = sessionRevocationWindowMs,
): Promise<boolean> => {
  await refresh(db, maxAgeMs);
  return ended.has(sessionId);
};

/**
 * Better Auth's `cookieCache.version`. It runs on each cache hit and when a
 * cache cookie is written. An ended session gets a value nothing can match,
 * so a cookie written while the revocation lands is never trusted later.
 */
export const sessionCacheVersion = async (
  db: D1Database,
  sessionId: string,
): Promise<string> =>
  (await sessionEnded(db, sessionId)) ? `ended-${crypto.randomUUID()}` : "1";

/** Records a session this isolate deleted, ahead of the next read. */
export const noteSessionEnded = (sessionId: string) => {
  ended.set(sessionId, Date.now());
};
