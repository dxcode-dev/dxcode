import type { ThreadId } from "@dx/domain";
import { sameOriginFetch } from "../../shared/same-origin-fetch.js";

/** Pointing must rest this long on Terminal before it wakes the Orb. */
export const TERMINAL_WARM_DWELL_MS = 150;
/** A Thread's Orb is warmed at most this often from one browser. */
const WARM_INTERVAL_MS = 30_000;
const lastWarmedAt = new Map<string, number>();

/**
 * The person is about to open the Terminal: ask Core to start waking the
 * Orb now, so the attach that follows joins a wake already under way. It
 * never waits, and a failure only means the attach wakes the Orb itself.
 */
export const warmTerminal = (threadId: ThreadId | string) => {
  const now = Date.now();
  if (now - (lastWarmedAt.get(threadId) ?? 0) < WARM_INTERVAL_MS) return;
  lastWarmedAt.set(threadId, now);
  void sameOriginFetch(
    `/v1/threads/${encodeURIComponent(threadId)}/terminal/warm`,
    { method: "POST", credentials: "same-origin", keepalive: true },
  )
    .then((response) => response.body?.cancel())
    .catch(() => undefined);
};

/**
 * Warms the Terminal once pointing has rested on it for the dwell; returns
 * the cancel for a pointer that moves on, so a passing hover wakes nothing.
 */
export const warmTerminalAfterDwell = (threadId: ThreadId | string) => {
  const timer = setTimeout(
    () => warmTerminal(threadId),
    TERMINAL_WARM_DWELL_MS,
  );
  return () => clearTimeout(timer);
};
