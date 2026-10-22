/**
 * WebSockets opened with a browser session close when that session ends.
 *
 * A socket is authenticated once, when it connects. The Worker route passes
 * the session that authenticated it to the object that holds the socket
 * (`browserSessionHeaders`), which keeps it on the socket's attachment.
 * While it holds such sockets, the holder checks them every
 * `sessionSocketCheckMs` against the same revocation records the cookie
 * cache uses (session-revocation.ts) and closes the ended session's sockets
 * with `SESSION_ENDED_CLOSE_CODE`; the web client then goes to sign-in.
 * HTTP requests are checked as they arrive, and the web client signs out on
 * the first one that gets 401, so this check only bounds a socket whose
 * browser makes no request.
 *
 * Expiry deletes no row until Better Auth next reads it, so a socket also
 * re-reads its session row once the expiry it knows has passed: a refreshed
 * session carries on with the later expiry, a gone or expired one closes.
 *
 * Sockets opened with an API token or an external application credential
 * carry no session and are never closed by this.
 */

import { SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON } from "@dx/api";
import { sessionEnded } from "./session-revocation.js";

export { SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON };

const DEFAULT_SESSION_SOCKET_CHECK_MS = 60_000;

/**
 * How often a holder checks the sessions behind its sockets: a minute, or
 * `DX_SESSION_SOCKET_CHECK_MS` (at least 1000) where a test shortens it.
 */
export const sessionSocketCheckMs = (env: {
  readonly DX_SESSION_SOCKET_CHECK_MS?: string;
}) => {
  const configured = Number(env.DX_SESSION_SOCKET_CHECK_MS);
  return Number.isSafeInteger(configured) && configured >= 1_000
    ? configured
    : DEFAULT_SESSION_SOCKET_CHECK_MS;
};

export interface BrowserSessionBinding {
  readonly sessionId: string;
  readonly userId: string;
  /**
   * Unix milliseconds after which the session row is read again; 0 when the
   * expiry is not known yet.
   */
  readonly expiresAt: number;
}

const SESSION_ID_HEADER = "x-dx-browser-session-id";
const SESSION_USER_HEADER = "x-dx-browser-session-user";
const SESSION_EXPIRES_HEADER = "x-dx-browser-session-expires-at";

/**
 * Sets the session headers on a request to a socket holder, replacing any a
 * caller sent. Without a session the headers are removed.
 */
export const setBrowserSessionHeaders = (
  headers: Headers,
  binding: BrowserSessionBinding | undefined,
) => {
  headers.delete(SESSION_ID_HEADER);
  headers.delete(SESSION_USER_HEADER);
  headers.delete(SESSION_EXPIRES_HEADER);
  if (binding === undefined) return headers;
  headers.set(SESSION_ID_HEADER, binding.sessionId);
  headers.set(SESSION_USER_HEADER, binding.userId);
  headers.set(SESSION_EXPIRES_HEADER, String(binding.expiresAt));
  return headers;
};

export const readBrowserSessionHeaders = (
  headers: Headers,
): BrowserSessionBinding | undefined => {
  const sessionId = headers.get(SESSION_ID_HEADER);
  const userId = headers.get(SESSION_USER_HEADER);
  const expiresAt = Number(headers.get(SESSION_EXPIRES_HEADER));
  if (
    sessionId === null ||
    sessionId.length === 0 ||
    sessionId.length > 256 ||
    userId === null ||
    userId.length === 0 ||
    userId.length > 256 ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt < 0
  )
    return undefined;
  return { sessionId, userId, expiresAt };
};

const expiryMs = (value: unknown) => {
  if (typeof value === "number") return value < 1e12 ? value * 1_000 : value;
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? undefined : parsed;
  }
  return undefined;
};

/** The session row's expiry, or undefined when the user has no such session. */
export const readSessionExpiry = async (
  db: D1Database,
  sessionId: string,
  userId: string,
) => {
  const row = await db
    .prepare(
      'SELECT "expiresAt" AS expires_at FROM "session" WHERE id = ? AND "userId" = ?',
    )
    .bind(sessionId, userId)
    .first<{ expires_at: unknown }>();
  return row === null ? undefined : expiryMs(row.expires_at);
};

export type BrowserSessionState =
  | { readonly state: "active" }
  | { readonly state: "renewed"; readonly expiresAt: number }
  | { readonly state: "ended" };

/**
 * Whether each session still stands. Every distinct session is checked once.
 * Throws when D1 cannot be read; the caller keeps its sockets and retries.
 */
export const checkBrowserSessions = async (
  db: D1Database,
  bindings: Iterable<BrowserSessionBinding>,
  nowMs: number,
): Promise<Map<string, BrowserSessionState>> => {
  const unique = new Map<string, BrowserSessionBinding>();
  for (const binding of bindings) {
    const known = unique.get(binding.sessionId);
    if (known === undefined || binding.expiresAt < known.expiresAt)
      unique.set(binding.sessionId, binding);
  }
  const states = new Map<string, BrowserSessionState>();
  await Promise.all(
    [...unique.values()].map(async (binding) => {
      if (await sessionEnded(db, binding.sessionId, 0)) {
        states.set(binding.sessionId, { state: "ended" });
        return;
      }
      if (binding.expiresAt > nowMs) {
        states.set(binding.sessionId, { state: "active" });
        return;
      }
      const expiresAt = await readSessionExpiry(
        db,
        binding.sessionId,
        binding.userId,
      );
      states.set(
        binding.sessionId,
        expiresAt === undefined || expiresAt <= nowMs
          ? { state: "ended" }
          : { state: "renewed", expiresAt },
      );
    }),
  );
  return states;
};

/**
 * Closes the sockets whose session ended and renews the expiry of the rest.
 * `binding` reads a socket's session; `renew` stores a later expiry; `end`
 * closes the socket and runs the holder's own cleanup. Returns whether any
 * socket still has a session to watch.
 */
export const enforceBrowserSessions = async <Socket>(
  db: D1Database,
  sockets: Iterable<Socket>,
  options: {
    readonly binding: (socket: Socket) => BrowserSessionBinding | undefined;
    readonly renew: (socket: Socket, expiresAt: number) => void;
    readonly end: (socket: Socket) => void;
    readonly nowMs?: number;
  },
): Promise<boolean> => {
  const bound: Array<readonly [Socket, BrowserSessionBinding]> = [];
  for (const socket of sockets) {
    const binding = options.binding(socket);
    if (binding !== undefined) bound.push([socket, binding]);
  }
  if (bound.length === 0) return false;
  const states = await checkBrowserSessions(
    db,
    bound.map(([, binding]) => binding),
    options.nowMs ?? Date.now(),
  );
  let watching = false;
  for (const [socket, binding] of bound) {
    const state = states.get(binding.sessionId);
    if (state?.state === "ended") {
      options.end(socket);
      continue;
    }
    watching = true;
    if (state?.state === "renewed") options.renew(socket, state.expiresAt);
  }
  return watching;
};

/** Closes a socket for an ended session; it may already be closed. */
export const closeForEndedSession = (socket: WebSocket) => {
  try {
    socket.close(SESSION_ENDED_CLOSE_CODE, SESSION_ENDED_CLOSE_REASON);
  } catch {
    // Already closed.
  }
};
