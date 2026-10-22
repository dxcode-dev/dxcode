// Who may open a Portal: the same rule as the Terminal. The Thread owner, or a
// workspace member with Contribute access, while the Thread is active.
//
// Revocation: a Portal cookie records when access was last checked. A request
// whose check is older than PORTAL_RECHECK_SECONDS checks again (Thread
// access, and that the dx session the handshake ran under still exists), so
// unsharing, archiving, or signing out closes the Portal within minutes. A
// small per-isolate cache absorbs the burst of asset requests a page load
// makes once its cookie turns stale, so D1 sees about one check per visitor
// and Thread per isolate per half minute rather than one per request.

import { Principal, type ThreadId } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { authorizeThreadRequest } from "../auth/authorize-thread.js";
import { readSessionExpiry } from "../auth/session-sockets.js";
import type { PortalSession } from "./session.js";

export type PortalAccess = "allowed" | "not-found" | "read-only" | "archived";

export const evaluatePortalAccess = async (
  db: unknown,
  userId: string,
  threadId: ThreadId,
): Promise<PortalAccess> => {
  const principal = Schema.decodeUnknownOption(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });
  if (Option.isNone(principal)) return "not-found";
  const result = await Effect.runPromise(
    authorizeThreadRequest(threadId, principal.value, db),
  );
  if (!result.authorized) return "not-found";
  if (result.access === "view") return "read-only";
  if (result.lifecycleState !== "active") return "archived";
  return "allowed";
};

/** Whether the dx session a Portal handshake ran under is still signed in. */
export const dxSessionActive = async (
  db: D1Database,
  sessionId: string,
  userId: string,
  nowMs: number,
) => {
  const expiresAt = await readSessionExpiry(db, sessionId, userId);
  return expiresAt !== undefined && expiresAt > nowMs;
};

const CACHE_MS = 30_000;
const CACHE_LIMIT = 1_000;
const allowedUntil = new Map<string, number>();

/** Re-checks a stale Portal session; true when it may continue. */
export const recheckPortalSession = async (
  db: D1Database,
  session: PortalSession,
  threadId: ThreadId,
  nowMs: number,
) => {
  const key = `${session.sessionId}\u0000${session.userId}\u0000${threadId}`;
  const cached = allowedUntil.get(key);
  if (cached !== undefined && cached > nowMs) return true;
  allowedUntil.delete(key);
  const [access, signedIn] = await Promise.all([
    evaluatePortalAccess(db, session.userId, threadId),
    dxSessionActive(db, session.sessionId, session.userId, nowMs),
  ]);
  if (access !== "allowed" || !signedIn) return false;
  if (allowedUntil.size >= CACHE_LIMIT) {
    for (const [entry, until] of allowedUntil)
      if (until <= nowMs) allowedUntil.delete(entry);
    if (allowedUntil.size >= CACHE_LIMIT) allowedUntil.clear();
  }
  allowedUntil.set(key, nowMs + CACHE_MS);
  return true;
};
