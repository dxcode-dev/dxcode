/**
 * A Flue agent session as a store a UI subscribes to. Flue publishes once per
 * stream chunk, and a network batch delivers many chunks in one task;
 * rendering each would block the UI. These stores publish at most once per
 * frame of the UI's `FrameScheduler`.
 */

/** A store: the latest value and a way to hear it changed. */
export interface SnapshotSource<Snapshot> {
  readonly getSnapshot: () => Snapshot;
  readonly subscribe: (listener: () => void) => () => void;
}

/** The UI's next paint, such as `requestAnimationFrame` in a browser. */
export interface FrameScheduler {
  readonly request: (callback: () => void) => unknown;
  readonly cancel: (handle: unknown) => void;
}

/**
 * Wraps a Flue session so its snapshots publish at most once per frame.
 * Skipped intermediate snapshots are never needed: each one is complete.
 * A browser does not run frames in a hidden tab, so it does not render
 * until visible again.
 */
export const frameCoalescedSnapshots = <Snapshot>(
  session: SnapshotSource<Snapshot>,
  frames: FrameScheduler,
): SnapshotSource<Snapshot> => {
  let snapshot: Snapshot = session.getSnapshot();
  let frame: unknown;
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
          frame ??= frames.request(flush);
        });
        // Anything published while unsubscribed is visible immediately.
        snapshot = session.getSnapshot();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size > 0) return;
        release?.();
        release = undefined;
        if (frame !== undefined) frames.cancel(frame);
        frame = undefined;
      };
    },
  };
};

/**
 * A Flue conversation that each view subscribes to for what it renders:
 * the transcript for every snapshot, the composer and error card only for the
 * values they show. `getSnapshot` returns the same agent until Flue publishes.
 */
export type AgentSource<Agent> = SnapshotSource<Agent>;

const noSubscription = () => () => {};

/** An agent its owner re-renders with each change, as an {@link AgentSource}. */
export const agentValueSource = <Agent>(agent: Agent): AgentSource<Agent> => ({
  subscribe: noSubscription,
  getSnapshot: () => agent,
});

/** Keeps the previous selection while `same` says nothing changed. */
export const createSelection = <T>() => {
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

/** The Flue session actions an agent carries beside its snapshot. */
export type AgentSessionAction =
  | "sendMessage"
  | "resume"
  | "abort"
  | "retrySend"
  | "resendPrompt"
  | "forgetSend"
  | "refresh"
  | "loadOlder"
  | "openHistoryWindow"
  | "loadWindowOlder"
  | "loadWindowNewer"
  | "closeHistoryWindow";

type AgentSessionLike<Snapshot> = SnapshotSource<Snapshot> & {
  readonly [Action in AgentSessionAction]: (...args: never[]) => unknown;
};

/** The session's agent, with its actions, published at most once per frame. */
export const frameCoalescedAgentSource = <
  Snapshot extends object,
  Session extends AgentSessionLike<Snapshot>,
>(
  session: Session,
  frames: FrameScheduler,
): AgentSource<Snapshot & Pick<Session, AgentSessionAction>> => {
  const snapshots = frameCoalescedSnapshots<Snapshot>(session, frames);
  const actions = {
    sendMessage: session.sendMessage.bind(session),
    resume: session.resume.bind(session),
    abort: session.abort.bind(session),
    retrySend: session.retrySend.bind(session),
    resendPrompt: session.resendPrompt.bind(session),
    forgetSend: session.forgetSend.bind(session),
    refresh: session.refresh,
    loadOlder: session.loadOlder,
    openHistoryWindow: session.openHistoryWindow,
    loadWindowOlder: session.loadWindowOlder,
    loadWindowNewer: session.loadWindowNewer,
    closeHistoryWindow: session.closeHistoryWindow,
  } as Pick<Session, AgentSessionAction>;
  let snapshot: Snapshot | undefined;
  let agent: (Snapshot & Pick<Session, AgentSessionAction>) | undefined;
  return {
    subscribe: snapshots.subscribe,
    getSnapshot: () => {
      const next = snapshots.getSnapshot();
      if (agent === undefined || next !== snapshot) {
        snapshot = next;
        agent = { ...next, ...actions };
      }
      return agent;
    },
  };
};
