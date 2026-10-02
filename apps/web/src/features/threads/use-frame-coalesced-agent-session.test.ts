import type { FlueAgentSession } from "@flue/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { frameCoalescedSnapshots } from "./use-frame-coalesced-agent-session.js";

const fakeSession = () => {
  let snapshot = { messages: [] as string[] };
  const listeners = new Set<() => void>();
  return {
    session: {
      getSnapshot: () => snapshot,
      subscribe: (listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    } as unknown as FlueAgentSession,
    publish: (message: string) => {
      snapshot = { messages: [...snapshot.messages, message] };
      for (const listener of listeners) listener();
    },
    listeners,
  };
};

const frames: FrameRequestCallback[] = [];
const runFrame = () => {
  for (const callback of frames.splice(0)) callback(0);
};

afterEach(() => {
  frames.length = 0;
  vi.unstubAllGlobals();
});

describe("frameCoalescedSnapshots", () => {
  it("publishes a burst of Flue snapshots once, on the next frame", () => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    const { session, publish } = fakeSession();
    const store = frameCoalescedSnapshots(session);
    const listener = vi.fn();
    store.subscribe(listener);

    for (const chunk of ["a", "b", "c"]) publish(chunk);
    expect(listener).not.toHaveBeenCalled();
    expect(store.getSnapshot()).toEqual({ messages: [] });
    expect(frames).toHaveLength(1);

    runFrame();
    expect(listener).toHaveBeenCalledOnce();
    expect(store.getSnapshot()).toEqual({ messages: ["a", "b", "c"] });
    // A stable snapshot between notifications satisfies useSyncExternalStore.
    expect(store.getSnapshot()).toBe(store.getSnapshot());
  });

  it("catches up on subscribe and releases the session and frame when unused", () => {
    const cancel = vi.fn();
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) =>
      frames.push(callback),
    );
    vi.stubGlobal("cancelAnimationFrame", cancel);
    const { session, publish, listeners } = fakeSession();
    const store = frameCoalescedSnapshots(session);
    publish("before subscribe");

    const unsubscribe = store.subscribe(() => {});
    expect(store.getSnapshot()).toEqual({ messages: ["before subscribe"] });
    publish("pending");
    unsubscribe();

    expect(listeners.size).toBe(0);
    expect(cancel).toHaveBeenCalledWith(1);
  });
});
