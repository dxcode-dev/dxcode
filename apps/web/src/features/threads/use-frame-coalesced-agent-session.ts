import {
  type AgentSource as ClientAgentSource,
  frameCoalescedAgentSource as clientFrameCoalescedAgentSource,
  frameCoalescedSnapshots as clientFrameCoalescedSnapshots,
  createSelection,
  type FrameScheduler,
} from "@dx/client";
import type { FlueAgentSession, useFlueAgentSession } from "@flue/react";
import * as React from "react";

export { agentValueSource } from "@dx/client";

type AgentSessionResult = ReturnType<typeof useFlueAgentSession>;
type Snapshot = ReturnType<FlueAgentSession["getSnapshot"]>;

/** Animation frames, read when called so a test's stubs apply. */
const animationFrames: FrameScheduler = {
  request: (callback) => requestAnimationFrame(callback),
  cancel: (handle) => cancelAnimationFrame(handle as number),
};

/**
 * Wraps a Flue session so its snapshots publish at most once per animation
 * frame (`frameCoalescedSnapshots` in `@dx/client`). Hidden tabs do not
 * render until visible again.
 */
export const frameCoalescedSnapshots = (session: FlueAgentSession) =>
  clientFrameCoalescedSnapshots<Snapshot>(session, animationFrames);

/** A Flue conversation as a store; see `AgentSource` in `@dx/client`. */
export type AgentSource<Agent = AgentSessionResult> = ClientAgentSource<Agent>;

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
): AgentSource =>
  clientFrameCoalescedAgentSource<Snapshot, FlueAgentSession>(
    session,
    animationFrames,
  ) as AgentSource;

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
