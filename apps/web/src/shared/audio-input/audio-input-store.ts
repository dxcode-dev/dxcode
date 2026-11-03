import { Schema } from "effect";

/**
 * Audio Input: the microphone dictation records from in this browser.
 * Device IDs belong to one browser profile on one machine, so the choice is
 * a device preference, not an account setting. Absent means the system
 * default.
 */
export const audioInputStorageKey = "dx:dictation-audio-input:v1";

const AudioInputEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  deviceId: Schema.NonEmptyString,
});

export interface AudioInputStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => string | undefined;
  readonly getServerSnapshot: () => string | undefined;
  /** `undefined` returns to the system default. */
  readonly choose: (deviceId: string | undefined) => void;
}

const decode = (raw: string | null) => {
  if (raw === null) return undefined;
  try {
    return Schema.decodeUnknownSync(AudioInputEnvelope)(JSON.parse(raw))
      .deviceId;
  } catch {
    return undefined;
  }
};

export const createAudioInputStore = (
  storage: Storage | undefined,
): AudioInputStore => {
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return decode(storage?.getItem(audioInputStorageKey) ?? null);
    } catch {
      return undefined;
    }
  };
  let deviceId = read();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== audioInputStorageKey) return;
    deviceId = read();
    notify();
  };
  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1 && typeof window !== "undefined")
        window.addEventListener("storage", onStorage);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && typeof window !== "undefined")
          window.removeEventListener("storage", onStorage);
      };
    },
    getSnapshot: () => deviceId,
    getServerSnapshot: () => undefined,
    choose: (next) => {
      deviceId = next;
      try {
        if (next === undefined) storage?.removeItem(audioInputStorageKey);
        else
          storage?.setItem(
            audioInputStorageKey,
            JSON.stringify({ version: 1, deviceId: next }),
          );
      } catch {
        // Storage may be full or disabled; the choice lasts for this page.
      }
      notify();
    },
  };
};

const browserStorage = () => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

/** This browser's Audio Input choice. */
export const audioInputStore = createAudioInputStore(browserStorage());
