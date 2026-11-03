// @vitest-environment happy-dom

import { describe, expect, it, vi } from "vitest";
import {
  audioInputStorageKey,
  createAudioInputStore,
} from "./audio-input-store.js";

const memoryStorage = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => void values.set(key, value),
    removeItem: (key: string) => void values.delete(key),
    values,
  } as unknown as Storage & { values: Map<string, string> };
};

describe("Audio Input store", () => {
  it("starts on the system default", () => {
    expect(createAudioInputStore(memoryStorage()).getSnapshot()).toBe(
      undefined,
    );
  });

  it("keeps a chosen microphone across a reload and clears it for the default", () => {
    const storage = memoryStorage();
    const store = createAudioInputStore(storage);
    const listener = vi.fn();
    store.subscribe(listener);

    store.choose("mic-2");
    expect(store.getSnapshot()).toBe("mic-2");
    expect(listener).toHaveBeenCalledOnce();
    expect(createAudioInputStore(storage).getSnapshot()).toBe("mic-2");

    store.choose(undefined);
    expect(store.getSnapshot()).toBe(undefined);
    expect(storage.values.has(audioInputStorageKey)).toBe(false);
  });

  it.each([
    ["not JSON", "{"],
    ["another version", JSON.stringify({ version: 2, deviceId: "mic-2" })],
    ["an empty device", JSON.stringify({ version: 1, deviceId: "" })],
    ["a number", JSON.stringify({ version: 1, deviceId: 4 })],
  ])("reads %s as the system default", (_name, raw) => {
    const storage = memoryStorage({ [audioInputStorageKey]: raw });
    expect(createAudioInputStore(storage).getSnapshot()).toBe(undefined);
  });

  it("keeps the choice for this page when storage refuses it", () => {
    const storage = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => undefined,
    } as unknown as Storage;
    const store = createAudioInputStore(storage);
    expect(store.getSnapshot()).toBe(undefined);
    store.choose("mic-2");
    expect(store.getSnapshot()).toBe("mic-2");
  });

  it("follows a choice made in another tab", () => {
    const storage = memoryStorage();
    const store = createAudioInputStore(storage);
    const listener = vi.fn();
    const unsubscribe = store.subscribe(listener);

    storage.values.set(
      audioInputStorageKey,
      JSON.stringify({ version: 1, deviceId: "mic-3" }),
    );
    window.dispatchEvent(
      new StorageEvent("storage", { key: audioInputStorageKey }),
    );

    expect(store.getSnapshot()).toBe("mic-3");
    expect(listener).toHaveBeenCalledOnce();
    unsubscribe();
  });
});
