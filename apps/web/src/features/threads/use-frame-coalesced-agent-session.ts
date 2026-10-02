import type { FlueAgentSession, useFlueAgentSession } from "@flue/react";
import * as React from "react";

type AgentSessionResult = ReturnType<typeof useFlueAgentSession>;
type Snapshot = ReturnType<FlueAgentSession["getSnapshot"]>;

/**
 * Wraps a Flue session so its snapshots publish at most once per animation
 * frame. Flue publishes once per stream chunk, and a network batch delivers
 * many chunks in one task; rendering each would block the main thread.
 * Skipped intermediate snapshots are never needed: each one is complete.
 * Hidden tabs do not render until visible again.
 */
export const frameCoalescedSnapshots = (session: FlueAgentSession) => {
  let snapshot: Snapshot = session.getSnapshot();
  let frame: number | undefined;
  let release: (() => void) | undefined;
  const listeners = new Set<() => void>();
  const flush = () => {
    frame = undefined;
    const next = session.getSnapshot();
    if (next === snapshot) return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      if (release === undefined) {
        release = session.subscribe(() => {
          frame ??= requestAnimationFrame(flush);
        });
        // Anything published while unsubscribed is visible immediately.
        snapshot = session.getSnapshot();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        release?.();
        release = undefined;
        if (frame !== undefined) cancelAnimationFrame(frame);
        frame = undefined;
      };
    },
  };
};

/** Same result as `useFlueAgentSession`, rendered at most once per frame. */
export function useFrameCoalescedAgentSession(
  session: FlueAgentSession,
): AgentSessionResult {
  const store = React.useMemo(
    () => frameCoalescedSnapshots(session),
    [session],
  );
  const snapshot = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getSnapshot,
  );
  const callbacks = React.useMemo(
    () => ({
      sendMessage: session.sendMessage.bind(session),
      resume: session.resume.bind(session),
      abort: session.abort.bind(session),
      retrySend: session.retrySend.bind(session),
      resendPrompt: session.resendPrompt.bind(session),
      refresh: session.refresh,
      loadOlder: session.loadOlder,
    }),
    [session],
  );
  return React.useMemo(
    () => ({ ...snapshot, ...callbacks }),
    [snapshot, callbacks],
  );
}
