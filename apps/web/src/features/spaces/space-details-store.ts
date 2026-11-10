import type { UserId } from "@dx/domain";
import { Schema } from "effect";
import * as React from "react";

/**
 * Whether a person hid the Space Details panel on this device. A device
 * preference per signed-in person: every Space opens the way they left the
 * last one, and another person on the same browser keeps their own.
 */
export const spaceDetailsStorageKey = (userId: UserId) =>
  `dx:space-details:v1:${userId}`;

const DetailsEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  hidden: Schema.Boolean,
});

export interface SpaceDetailsStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
  readonly getServerSnapshot: () => boolean;
  readonly setHidden: (hidden: boolean) => void;
}

const decodeHidden = (raw: string | null) => {
  if (raw === null) return false;
  try {
    return Schema.decodeUnknownSync(DetailsEnvelope)(JSON.parse(raw)).hidden;
  } catch {
    return false;
  }
};

export const createSpaceDetailsStore = (
  storage: Storage | undefined,
  userId: UserId,
): SpaceDetailsStore => {
  const key = spaceDetailsStorageKey(userId);
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return decodeHidden(storage?.getItem(key) ?? null);
    } catch {
      return false;
    }
  };
  let hidden = read();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== key) return;
    hidden = read();
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
    getSnapshot: () => hidden,
    getServerSnapshot: () => false,
    setHidden: (next) => {
      hidden = next;
      try {
        storage?.setItem(key, JSON.stringify({ version: 1, hidden: next }));
      } catch {
        // Storage may be full or disabled; the choice holds for this visit.
      }
      notify();
    },
  };
};

const browserStores = new Map<UserId, SpaceDetailsStore>();

/** Reading `localStorage` itself throws where storage is blocked. */
const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const browserStore = (userId: UserId) => {
  const existing = browserStores.get(userId);
  if (existing !== undefined) return existing;
  const store = createSpaceDetailsStore(browserStorage(), userId);
  browserStores.set(userId, store);
  return store;
};

/** Whether the person hid Space Details, and a setter that remembers it. */
export const useSpaceDetailsHidden = (userId: UserId) => {
  const store = browserStore(userId);
  const hidden = React.useSyncExternalStore(
    store.subscribe,
    store.getSnapshot,
    store.getServerSnapshot,
  );
  return [hidden, store.setHidden] as const;
};
