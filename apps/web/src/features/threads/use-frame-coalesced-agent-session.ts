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

/**
 * A Flue conversation that each component subscribes to for what it renders:
 * the transcript for every snapshot, the composer and error card only for the
 * values they show. `getSnapshot` returns the same agent until Flue publishes.
 */
export interface AgentSource<Agent = AgentSessionResult> {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => Agent;
}

const noSubscription = () => () => {};

/** An agent its owner re-renders with each change, as an {@link AgentSource}. */
export const agentValueSource = <Agent>(agent: Agent): AgentSource<Agent> => ({
  subscribe: noSubscription,
  getSnapshot: () => agent,
});

/** Keeps the previous selection while `same` says nothing changed. */
const createSelection = <T>() => {
  let selected: { readonly value: T } | undefined;
  return {
    keep: (next: T, same: (previous: T, next: T) => boolean) => {
      if (selected !== undefined && same(selected.value, next))
        return selected.value;
      selected = { value: next };
      return next;
    },
  };
};

/**
 * Subscribes the caller to one value it renders from the agent, so it
 * re-renders when that value changes rather than on every snapshot.
 */
export function useAgentSelection<Agent, T>(
  source: AgentSource<Agent>,
  select: (agent: Agent) => T,
  same: (previous: T, next: T) => boolean = Object.is,
): T {
  const [selection] = React.useState(createSelection<T>);
  const snapshot = () => selection.keep(select(source.getSnapshot()), same);
  return React.useSyncExternalStore(source.subscribe, snapshot, snapshot);
}

/** The session's agent, with its actions, published at most once per frame. */
export const frameCoalescedAgentSource = (
  session: FlueAgentSession,
): AgentSource => {
  const snapshots = frameCoalescedSnapshots(session);
  const actions = {
    sendMessage: session.sendMessage.bind(session),
    resume: session.resume.bind(session),
    abort: session.abort.bind(session),
    retrySend: session.retrySend.bind(session),
    resendPrompt: session.resendPrompt.bind(session),
    refresh: session.refresh,
    loadOlder: session.loadOlder,
  };
  let snapshot: Snapshot | undefined;
  let agent: AgentSessionResult | undefined;
  return {
    subscribe: snapshots.subscribe,
    getSnapshot: () => {
      const next = snapshots.getSnapshot();
      if (agent === undefined || next !== snapshot) {
        snapshot = next;
        agent = { ...next, ...actions } as AgentSessionResult;
      }
      return agent;
    },
  };
};

// The last session's source; a new session gets its own.
const createSourceCell = () => {
  let last:
    | { readonly session: FlueAgentSession; readonly source: AgentSource }
    | undefined;
  return (session: FlueAgentSession) => {
    if (last?.session !== session)
      last = { session, source: frameCoalescedAgentSource(session) };
    return last.source;
  };
};

/** The retained session as an {@link AgentSource}, one per session. */
export const useFrameCoalescedAgentSource = (
  session: FlueAgentSession,
): AgentSource => {
  const [sourceFor] = React.useState(createSourceCell);
  return sourceFor(session);
};
