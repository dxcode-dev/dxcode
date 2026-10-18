// Public Portal links (D1 `portal_public_links`, migration 0079). The owner
// makes one port of an active Thread public for 1 hour, 1 day, or 7 days;
// anyone may then open it without signing in, as an anonymous visitor.
//
// Every request without a Portal session asks whether its host is public, so
// the answer is cached per isolate for PUBLIC_LINK_CACHE_MS, public or not.
// Expiry is exact (each request compares the cached expiry with the clock).
// Revoking or archiving reaches this isolate at once when the same isolate
// served the change (local development, where Core serves Portals), and
// every other isolate, including the deployed Portal Worker's, within
// PUBLIC_LINK_CACHE_MS. D1 sees at most one lookup per Portal host per
// isolate per that window.

import { THREAD_PORTAL_PUBLIC_LIMIT } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { randomToken } from "./crypto.js";

export const PUBLIC_LINK_CACHE_MS = 10_000;
const CACHE_LIMIT = 1_000;

export const PUBLIC_LINK_DURATIONS_MS = {
  "1h": 60 * 60 * 1_000,
  "1d": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
} as const;

export interface PublicLink {
  readonly port: number;
  /** Changes with each new link; binds a visitor's first-visit acknowledgement. */
  readonly id: string;
  /** Unix milliseconds. */
  readonly expiresAt: number;
}

interface CachedLink {
  readonly link: PublicLink | undefined;
  readonly until: number;
}

const cache = new Map<string, CachedLink>();
const cacheKey = (threadId: ThreadId, port: number) => `${threadId}:${port}`;

const remember = (key: string, entry: CachedLink, nowMs: number) => {
  if (cache.size >= CACHE_LIMIT) {
    for (const [stale, cached] of cache)
      if (cached.until <= nowMs) cache.delete(stale);
    if (cache.size >= CACHE_LIMIT) cache.clear();
  }
  cache.set(key, entry);
};

/** Drops this isolate's cached answer after a change through the API. */
export const forgetPublicLink = (threadId: ThreadId, port: number) => {
  cache.delete(cacheKey(threadId, port));
};

/** The port's public link, if it is public now and its Thread is active. */
export const findPublicLink = async (
  db: D1Database,
  threadId: ThreadId,
  port: number,
  nowMs: number,
): Promise<PublicLink | undefined> => {
  const key = cacheKey(threadId, port);
  const cached = cache.get(key);
  if (cached !== undefined && cached.until > nowMs)
    return cached.link !== undefined && cached.link.expiresAt > nowMs
      ? cached.link
      : undefined;
  const row = await db
    .prepare(
      `SELECT link.id, link.expires_at FROM portal_public_links AS link
         JOIN threads ON threads.id = link.thread_id
        WHERE link.thread_id = ? AND link.port = ? AND link.expires_at > ?
          AND threads.lifecycle_state = 'active'`,
    )
    .bind(threadId, port, nowMs)
    .first<{ id: string; expires_at: number }>();
  const link =
    row === null ? undefined : { port, id: row.id, expiresAt: row.expires_at };
  remember(key, { link, until: nowMs + PUBLIC_LINK_CACHE_MS }, nowMs);
  return link;
};

/** The Thread's unexpired public links, by port. */
export const listPublicLinks = async (
  db: D1Database,
  threadId: ThreadId,
  nowMs: number,
): Promise<ReadonlyArray<PublicLink>> => {
  const { results } = await db
    .prepare(
      `SELECT port, id, expires_at FROM portal_public_links
        WHERE thread_id = ? AND expires_at > ? ORDER BY port`,
    )
    .bind(threadId, nowMs)
    .all<{ port: number; id: string; expires_at: number }>();
  return results.map((row) => ({
    port: row.port,
    id: row.id,
    expiresAt: row.expires_at,
  }));
};

/**
 * Makes a port public until `nowMs + durationMs`, or extends the link it
 * already has. One statement checks the per-Thread cap and writes, so two
 * concurrent requests cannot both take the last slot. Call only for an
 * active Thread; archiving deletes the rows (a trigger) and lookups also
 * require an active Thread.
 */
export const publishPortal = async (
  db: D1Database,
  threadId: ThreadId,
  port: number,
  userId: string,
  durationMs: number,
  nowMs: number,
): Promise<PublicLink | "limit"> => {
  const expiresAt = nowMs + durationMs;
  const [, written] = await db.batch([
    db
      .prepare(
        "DELETE FROM portal_public_links WHERE thread_id = ? AND expires_at <= ?",
      )
      .bind(threadId, nowMs),
    db
      .prepare(
        `INSERT INTO portal_public_links
           (thread_id, port, id, created_by_user_id, expires_at, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6
          WHERE (SELECT count(*) FROM portal_public_links
                  WHERE thread_id = ?1 AND port <> ?2) < ?7
         ON CONFLICT (thread_id, port) DO UPDATE
           SET expires_at = excluded.expires_at,
               created_by_user_id = excluded.created_by_user_id
         RETURNING id, expires_at`,
      )
      .bind(
        threadId,
        port,
        randomToken(),
        userId,
        expiresAt,
        nowMs,
        THREAD_PORTAL_PUBLIC_LIMIT,
      ),
  ]);
  forgetPublicLink(threadId, port);
  const row = (
    written?.results as
      | ReadonlyArray<{ id: string; expires_at: number }>
      | undefined
  )?.[0];
  return row === undefined
    ? "limit"
    : { port, id: row.id, expiresAt: row.expires_at };
};

export const revokePortal = async (
  db: D1Database,
  threadId: ThreadId,
  port: number,
) => {
  await db
    .prepare("DELETE FROM portal_public_links WHERE thread_id = ? AND port = ?")
    .bind(threadId, port)
    .run();
  forgetPublicLink(threadId, port);
};

// Anonymous traffic to one public Portal host, per isolate: a token bucket
// that allows a dev server's first page load (hundreds of module requests)
// and then about 20 requests a second. Signed-in members are not counted.
const BUCKET_CAPACITY = 1_000;
const BUCKET_REFILL_PER_MS = 20 / 1_000;
const buckets = new Map<string, { tokens: number; at: number }>();

/** Takes one request from the host's budget; false when it is spent. */
export const takePublicRequest = (host: string, nowMs: number) => {
  const bucket = buckets.get(host);
  const tokens =
    bucket === undefined
      ? BUCKET_CAPACITY
      : Math.min(
          BUCKET_CAPACITY,
          bucket.tokens + Math.max(0, nowMs - bucket.at) * BUCKET_REFILL_PER_MS,
        );
  if (bucket === undefined && buckets.size >= CACHE_LIMIT) {
    // A full bucket is the default, so forgetting the fullest loses nothing.
    for (const [key, entry] of buckets)
      if (
        entry.tokens + (nowMs - entry.at) * BUCKET_REFILL_PER_MS >=
        BUCKET_CAPACITY
      )
        buckets.delete(key);
    if (buckets.size >= CACHE_LIMIT) buckets.clear();
  }
  if (tokens < 1) {
    buckets.set(host, { tokens, at: nowMs });
    return false;
  }
  buckets.set(host, { tokens: tokens - 1, at: nowMs });
  return true;
};
