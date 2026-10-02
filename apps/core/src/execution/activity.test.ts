import { describe, expect, it, vi } from "vitest";
import {
  type ActivityHost,
  createWorkspaceActivity,
  DEFAULT_WORKSPACE_INACTIVITY_MS,
} from "./activity.js";

const host = (): ActivityHost & { setDeadline: ReturnType<typeof vi.fn> } => ({
  setDeadline: vi.fn(async () => undefined),
});

const deferred = <A>() => {
  let resolve!: (value: A) => void;
  const promise = new Promise<A>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
};

describe("workspace activity coordinator", () => {
  it.each(["success", "failure", "interruption"] as const)(
    "releases an admitted command after %s",
    async (settlement) => {
      const provider = host();
      const activity = createWorkspaceActivity(provider);
      const result = activity.runCommand(10_000, async () => {
        if (settlement !== "success") throw new Error(settlement);
        return 7;
      });

      if (settlement === "success") await expect(result).resolves.toBe(7);
      else await expect(result).rejects.toThrow(settlement);
      expect(await activity.isActive()).toBe(false);
    },
  );

  it("keeps overlapping bounded commands active and ends exactly on the final release", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const activity = createWorkspaceActivity(provider);
      const first = activity.acquireCommand(10_000);
      const second = activity.acquireCommand(20_000);
      await vi.runAllTicks();
      const activeCalls = provider.setDeadline.mock.calls.length;
      first.release();
      first.release();
      await vi.runAllTicks();
      expect(provider.setDeadline).toHaveBeenCalledTimes(activeCalls + 1);
      const beforeFinalRelease = provider.setDeadline.mock.calls.length;
      second.release();
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([300_000]);
      expect(provider.setDeadline).toHaveBeenCalledTimes(
        beforeFinalRelease + 1,
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("expires stale command leases and later activity resumes renewal", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const activity = createWorkspaceActivity(provider);
      activity.acquireCommand(1_000);
      await vi.advanceTimersByTimeAsync(1_000);
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([300_000]);
      const later = activity.acquireCommand(2_000);
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([300_000]);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.setDeadline.mock.calls.length).toBeGreaterThan(2);
      later.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews a long command without an attached terminal", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const activity = createWorkspaceActivity(provider, undefined, 60_000);
      const command = activity.acquireCommand(120_000);
      await vi.runAllTicks();

      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.setDeadline.mock.calls).toEqual([[60_000], [60_000]]);

      command.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("renews for an attached silent foreground command but not an idle shell or detached background work", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      let foreground = true;
      const activity = createWorkspaceActivity(provider);
      const detach = activity.attachTerminal(async () => foreground);
      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.setDeadline.mock.calls.length).toBeGreaterThanOrEqual(2);
      foreground = false;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([300_000]);
      const calls = provider.setDeadline.mock.calls.length;
      detach();
      foreground = true;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.setDeadline).toHaveBeenCalledTimes(calls);
    } finally {
      vi.useRealTimers();
    }
  });

  it("terminal input qualifies but provider failures stay contained", async () => {
    vi.useFakeTimers();
    try {
      const provider: ActivityHost = {
        setDeadline: vi.fn(async () => {
          throw new Error("provider cause");
        }),
      };
      const activity = createWorkspaceActivity(provider);
      expect(() => activity.recordTerminalInput()).not.toThrow();
      await vi.advanceTimersByTimeAsync(300_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes one deadline from terminal input without adding another after retention", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const onIdle = vi.fn();
      const provider = host();
      const activity = createWorkspaceActivity(
        { ...provider, onIdle },
        undefined,
        60_000,
      );

      activity.recordTerminalInput();
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls).toEqual([[60_000]]);
      expect(vi.getTimerCount()).toBe(1);

      await vi.advanceTimersByTimeAsync(60_000);
      expect(await activity.isActive()).toBe(false);
      expect(provider.setDeadline.mock.calls).toEqual([[60_000]]);
      expect(onIdle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes the deadline again after a reconnect replaced it while retained", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(0);
      const onIdle = vi.fn();
      const provider = host();
      const activity = createWorkspaceActivity(
        { ...provider, onIdle },
        undefined,
        60_000,
      );
      // Idle resident Terminal: attached, then typed into once.
      let detach = activity.attachTerminal(async () => false);
      await vi.runAllTicks();
      activity.recordTerminalInput();
      await vi.runAllTicks();
      const published = provider.setDeadline.mock.calls.length;
      // The daemon socket drops within the input's retention window, so the
      // coordinator survives; the wake's E2B connect then replaces the
      // provider deadline and the daemon attaches again.
      await vi.advanceTimersByTimeAsync(20_000);
      detach();
      expect(onIdle).not.toHaveBeenCalled();
      activity.deadlineReplaced();
      detach = activity.attachTerminal(async () => false);
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls.slice(published)).toEqual([
        [60_000],
      ]);
      detach();
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes a replaced deadline on a fresh coordinator but not while a lease renews", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const activity = createWorkspaceActivity(provider, undefined, 60_000);
      // A Files-only wake: the connect set the E2B timeout and no Terminal
      // attaches, so nothing else would publish the 60 s deadline.
      activity.deadlineReplaced();
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls).toEqual([[60_000]]);
      // An attaching Terminal does not publish it a second time.
      const detach = activity.attachTerminal(async () => false);
      await vi.runAllTicks();
      expect(provider.setDeadline).toHaveBeenCalledOnce();
      detach();
      const command = activity.acquireCommand(10_000);
      await vi.runAllTicks();
      const calls = provider.setDeadline.mock.calls.length;
      activity.deadlineReplaced();
      await vi.runAllTicks();
      expect(provider.setDeadline).toHaveBeenCalledTimes(calls);
      command.release();
    } finally {
      vi.useRealTimers();
    }
  });

  it("lets renewing command activity own the final deadline after terminal input", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const activity = createWorkspaceActivity(provider, undefined, 60_000);
      const command = activity.acquireCommand(120_000);
      await vi.runAllTicks();
      const callsBeforeInput = provider.setDeadline.mock.calls.length;

      activity.recordTerminalInput();
      await vi.runAllTicks();
      expect(provider.setDeadline).toHaveBeenCalledTimes(callsBeforeInput);

      command.release();
      await vi.runAllTicks();
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([60_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("publishes renewals and final deadlines in trigger order", async () => {
    const publications: Array<ReturnType<typeof deferred<void>>> = [];
    const setDeadline = vi.fn(() => {
      const publication = deferred<void>();
      publications.push(publication);
      return publication.promise;
    });
    const provider: ActivityHost = {
      setDeadline,
    };
    const activity = createWorkspaceActivity(provider);

    const first = activity.acquireCommand(1_000);
    first.release();
    const later = activity.acquireCommand(1_000);
    expect(setDeadline).toHaveBeenCalledOnce();

    publications[0]?.resolve();
    await vi.waitFor(() => expect(setDeadline).toHaveBeenCalledTimes(2));
    publications[1]?.resolve();
    await vi.waitFor(() => expect(setDeadline).toHaveBeenCalledTimes(3));
    later.release();
    expect(setDeadline).toHaveBeenCalledTimes(3);
    publications[2]?.resolve();
    await vi.waitFor(() => expect(setDeadline).toHaveBeenCalledTimes(4));
    publications[3]?.resolve();

    expect(setDeadline.mock.invocationCallOrder).toEqual(
      [...setDeadline.mock.invocationCallOrder].sort((a, b) => a - b),
    );
  });

  it("does not let detaching replaced terminal A clear terminal B", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const pollA = deferred<boolean>();
      const activity = createWorkspaceActivity(provider);
      const releaseA = activity.attachTerminal(() => pollA.promise);
      const releaseB = activity.attachTerminal(async () => true);
      releaseA();
      pollA.resolve(false);
      await vi.runAllTicks();

      expect(await activity.isActive()).toBe(true);
      const before = provider.setDeadline.mock.calls.length;
      await vi.advanceTimersByTimeAsync(30_000);
      expect(provider.setDeadline.mock.calls.length).toBeGreaterThan(before);
      releaseB();
      await vi.runAllTicks();
      const afterFinal = provider.setDeadline.mock.calls.length;
      await vi.advanceTimersByTimeAsync(60_000);
      expect(provider.setDeadline).toHaveBeenCalledTimes(afterFinal);
      expect(provider.setDeadline.mock.calls.at(-1)).toEqual([300_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the prior polling chain when replacing a terminal", async () => {
    vi.useFakeTimers();
    try {
      const activity = createWorkspaceActivity(host());
      activity.attachTerminal(async () => false);
      await vi.runAllTicks();
      expect(vi.getTimerCount()).toBe(1);

      const pollB = deferred<boolean>();
      activity.attachTerminal(() => pollB.promise);
      expect(vi.getTimerCount()).toBe(0);
      pollB.resolve(false);
      await vi.runAllTicks();
      expect(vi.getTimerCount()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("announces idle only after the final retained activity is released", async () => {
    const onIdle = vi.fn();
    const activity = createWorkspaceActivity({
      setDeadline: vi.fn(async () => undefined),
      onIdle,
    });
    const command = activity.acquireCommand(1_000);
    const detach = activity.attachTerminal(async () => false);

    command.release();
    expect(onIdle).not.toHaveBeenCalled();
    detach();

    expect(onIdle).toHaveBeenCalledOnce();
  });

  it("retains activity until an untimed opening reservation is released", async () => {
    vi.useFakeTimers();
    try {
      const onIdle = vi.fn();
      const activity = createWorkspaceActivity({
        setDeadline: vi.fn(async () => undefined),
        onIdle,
      });
      const opening = activity.retain();

      await vi.advanceTimersByTimeAsync(DEFAULT_WORKSPACE_INACTIVITY_MS * 2);
      expect(onIdle).not.toHaveBeenCalled();

      opening.release();

      expect(onIdle).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not let terminal A's deferred poll mutate or renew after detach", async () => {
    vi.useFakeTimers();
    try {
      const provider = host();
      const pollA = deferred<boolean>();
      const activity = createWorkspaceActivity(provider);
      const releaseA = activity.attachTerminal(() => pollA.promise);
      releaseA();
      await vi.runAllTicks();
      const afterFinal = provider.setDeadline.mock.calls.length;

      pollA.resolve(true);
      await vi.runAllTicks();
      await vi.advanceTimersByTimeAsync(60_000);

      expect(await activity.isActive()).toBe(false);
      expect(provider.setDeadline).toHaveBeenCalledTimes(afterFinal);
    } finally {
      vi.useRealTimers();
    }
  });
});
