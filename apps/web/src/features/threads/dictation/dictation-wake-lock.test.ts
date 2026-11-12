// @vitest-environment happy-dom

// Ways keeping the screen awake during dictation can fail:
// 1. No lock is requested, so the phone sleeps and the microphone pauses.
// 2. The lock outlives dictation after finish, cancel, the length limit, or a
//    microphone error, and drains the battery.
// 3. The lock request resolves after dictation already stopped and leaks.
// 4. The browser drops the lock when the page is hidden, and dictation that is
//    still running on return is not covered again.
// 5. A browser without the API, or one that refuses the lock (battery saver,
//    permissions policy), breaks or blocks dictation.

import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationCapture } from "./dictation-capture.js";

type Sentinel = { released: boolean; release: () => Promise<void> };

const stubMicrophone = (
  getUserMedia: () => Promise<MediaStream> = async () =>
    ({ getTracks: () => [{ stop: vi.fn() }] }) as unknown as MediaStream,
) => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: vi.fn(getUserMedia) },
  });
  class SilentAudioContext {
    readonly sampleRate = 16_000;
    readonly state = "running";
    readonly destination = {};
    readonly createMediaStreamSource = vi.fn(() => ({ connect: vi.fn() }));
    readonly createScriptProcessor = vi.fn(() => ({
      connect: vi.fn(),
      disconnect: vi.fn(),
    }));
    readonly close = vi.fn();
  }
  vi.stubGlobal("AudioContext", SilentAudioContext);
};

const stubWakeLock = (
  request: () => Promise<Sentinel> = async () => sentinel(),
) => {
  const held: Sentinel[] = [];
  const wakeLock = {
    request: vi.fn(async (type: string) => {
      expect(type).toBe("screen");
      const lock = await request();
      held.push(lock);
      return lock;
    }),
  };
  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    value: wakeLock,
  });
  return {
    request: wakeLock.request,
    awake: () => held.some((lock) => !lock.released),
    /** The browser drops every lock when the page is hidden. */
    hide: () => {
      for (const lock of held) lock.released = true;
      setVisibility("hidden");
    },
  };
};

const sentinel = (): Sentinel => {
  const lock: Sentinel = {
    released: false,
    release: vi.fn(async () => {
      lock.released = true;
    }),
  };
  return lock;
};

const setVisibility = (state: DocumentVisibilityState) => {
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    value: state,
  });
  document.dispatchEvent(new Event("visibilitychange"));
};

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  setVisibility("visible");
  Reflect.deleteProperty(navigator, "wakeLock");
  vi.unstubAllGlobals();
});

describe("dictation keeps the screen awake", () => {
  it("while recording, and lets it sleep after finishing", async () => {
    stubMicrophone();
    const lock = stubWakeLock();
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();
    expect(capture.getSnapshot().state).toBe("recording");
    expect(lock.awake()).toBe(true);

    await capture.finish();
    expect(lock.awake()).toBe(false);
  });

  it("lets the screen sleep after cancelling", async () => {
    stubMicrophone();
    const lock = stubWakeLock();
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();
    await capture.cancel();

    expect(lock.awake()).toBe(false);
  });

  it("never holds the screen when the microphone fails", async () => {
    stubMicrophone(async () => {
      throw new DOMException("denied", "NotAllowedError");
    });
    const lock = stubWakeLock();
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();

    expect(capture.getSnapshot().state).toBe("error");
    expect(lock.awake()).toBe(false);
  });

  it("releases a lock granted after dictation already stopped", async () => {
    stubMicrophone();
    let grant!: (lock: Sentinel) => void;
    const lock = stubWakeLock(
      () =>
        new Promise<Sentinel>((resolve) => {
          grant = resolve;
        }),
    );
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await capture.cancel();
    grant(sentinel());
    await settle();

    expect(lock.awake()).toBe(false);
  });

  it("takes the lock again when the page returns during dictation", async () => {
    stubMicrophone();
    const lock = stubWakeLock();
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();
    lock.hide();
    expect(lock.awake()).toBe(false);
    setVisibility("visible");
    await settle();

    expect(lock.awake()).toBe(true);
    await capture.finish();
    expect(lock.awake()).toBe(false);
  });

  it("does not take the lock when the page returns after dictation", async () => {
    stubMicrophone();
    const lock = stubWakeLock();
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();
    lock.hide();
    await capture.finish();
    setVisibility("visible");
    await settle();

    expect(lock.request).toHaveBeenCalledOnce();
    expect(lock.awake()).toBe(false);
  });

  it("still records where the browser has no Screen Wake Lock", async () => {
    stubMicrophone();
    Reflect.deleteProperty(navigator, "wakeLock");
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();

    expect(capture.getSnapshot().state).toBe("recording");
    await capture.finish();
    expect(capture.getSnapshot().state).toBe("idle");
  });

  it("still records when the browser refuses the lock", async () => {
    stubMicrophone();
    stubWakeLock(async () => {
      throw new DOMException("battery saver", "NotAllowedError");
    });
    const capture = new DictationCapture(() => undefined);

    await capture.start(vi.fn());
    await settle();

    expect(capture.getSnapshot().state).toBe("recording");
    await capture.finish();
    expect(capture.getSnapshot().state).toBe("idle");
  });
});
