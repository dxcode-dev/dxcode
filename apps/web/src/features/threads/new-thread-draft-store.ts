import type { UserId, WorkspaceId } from "@dx/domain";
import { Schema } from "effect";

export const NEW_THREAD_DRAFT_MAX_BYTES = 64 * 1024;
export const NEW_THREAD_DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1_000;
export const newThreadDraftStoragePrefix = "dx:new-thread-draft:v1:";

const DraftEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  text: Schema.String,
  updatedAt: Schema.Number,
  expiresAt: Schema.Number,
});

type DraftEnvelope = typeof DraftEnvelope.Type;
export interface NewThreadDraftScope {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId | "personal";
}
export interface NewThreadDraftSnapshot {
  readonly text: string;
  readonly warning?: "too-large" | "storage-unavailable";
}
export interface NewThreadDraftStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NewThreadDraftSnapshot;
  readonly getServerSnapshot: () => NewThreadDraftSnapshot;
  readonly setText: (text: string) => void;
  readonly flush: () => void;
  readonly clear: () => void;
}

const emptySnapshot: NewThreadDraftSnapshot = { text: "" };
const utf8Size = (text: string) => new TextEncoder().encode(text).byteLength;
const scopeKey = ({ userId, workspaceId }: NewThreadDraftScope) =>
  `${newThreadDraftStoragePrefix}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;

const decode = (raw: string | null, now: number): DraftEnvelope | undefined => {
  if (raw === null) return undefined;
  try {
    const value = Schema.decodeUnknownSync(DraftEnvelope)(JSON.parse(raw));
    if (
      value.expiresAt <= now ||
      utf8Size(value.text) > NEW_THREAD_DRAFT_MAX_BYTES
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
};

export const createNewThreadDraftStore = ({
  scope,
  storage,
  now = Date.now,
  subscribeToStorage,
  subscribeToPageHide,
  debounceMs = 150,
}: {
  readonly scope: NewThreadDraftScope;
  readonly storage?: Storage;
  readonly now?: () => number;
  readonly subscribeToStorage?: (
    listener: (key: string | null, newValue: string | null) => void,
  ) => () => void;
  readonly subscribeToPageHide?: (listener: () => void) => () => void;
  readonly debounceMs?: number;
}): NewThreadDraftStore => {
  const key = scopeKey(scope);
  const listeners = new Set<() => void>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let persistedUpdatedAt = 0;
  let snapshot = emptySnapshot;
  let unsubscribeStorage: (() => void) | undefined;
  let unsubscribePageHide: (() => void) | undefined;
  let locallyEditedAt = 0;

  const publish = (next: NewThreadDraftSnapshot) => {
    if (snapshot.text === next.text && snapshot.warning === next.warning)
      return;
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const remove = () => {
    try {
      storage?.removeItem(key);
    } catch {
      // The mount-scoped snapshot remains authoritative when storage is blocked.
    }
  };
  const read = () => {
    let envelope: DraftEnvelope | undefined;
    try {
      envelope = decode(storage?.getItem(key) ?? null, now());
    } catch {
      publish({ ...snapshot, warning: "storage-unavailable" });
      return;
    }
    if (envelope === undefined) {
      remove();
      return;
    }
    persistedUpdatedAt = envelope.updatedAt;
    snapshot = { text: envelope.text };
    // Reading is activity: refresh the seven-day sliding retention window.
    try {
      storage?.setItem(
        key,
        JSON.stringify({
          ...envelope,
          expiresAt: now() + NEW_THREAD_DRAFT_TTL_MS,
        }),
      );
    } catch {
      snapshot = { text: envelope.text, warning: "storage-unavailable" };
    }
  };
  read();

  const flush = () => {
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if (
      snapshot.text === "" ||
      utf8Size(snapshot.text) > NEW_THREAD_DRAFT_MAX_BYTES
    )
      return;
    if (storage === undefined) {
      publish({ text: snapshot.text, warning: "storage-unavailable" });
      return;
    }
    const timestamp = Math.max(now(), persistedUpdatedAt + 1, locallyEditedAt);
    try {
      storage?.setItem(
        key,
        JSON.stringify({
          version: 1,
          text: snapshot.text,
          updatedAt: timestamp,
          expiresAt: timestamp + NEW_THREAD_DRAFT_TTL_MS,
        } satisfies DraftEnvelope),
      );
      persistedUpdatedAt = timestamp;
      publish({ text: snapshot.text });
    } catch {
      publish({ text: snapshot.text, warning: "storage-unavailable" });
    }
  };

  const applyStorageValue = (newValue: string | null) => {
    const envelope = decode(newValue, now());
    if (newValue === null) {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      locallyEditedAt = 0;
      persistedUpdatedAt = 0;
      publish(emptySnapshot);
      return;
    }
    if (envelope === undefined) return;
    if (
      envelope.updatedAt > persistedUpdatedAt &&
      envelope.updatedAt > locallyEditedAt
    ) {
      persistedUpdatedAt = envelope.updatedAt;
      publish({ text: envelope.text });
    }
  };

  return {
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        if (subscribeToStorage !== undefined)
          unsubscribeStorage = subscribeToStorage((changedKey, newValue) => {
            if (changedKey !== key) return;
            applyStorageValue(newValue);
          });
        if (storage !== undefined)
          try {
            applyStorageValue(storage.getItem(key));
          } catch {
            publish({ ...snapshot, warning: "storage-unavailable" });
          }
        if (subscribeToPageHide !== undefined)
          unsubscribePageHide = subscribeToPageHide(flush);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeStorage?.();
          unsubscribeStorage = undefined;
          unsubscribePageHide?.();
          unsubscribePageHide = undefined;
        }
      };
    },
    getSnapshot: () => snapshot,
    getServerSnapshot: () => emptySnapshot,
    setText: (text) => {
      locallyEditedAt = Math.max(
        now(),
        persistedUpdatedAt + 1,
        locallyEditedAt + 1,
      );
      const oversized = utf8Size(text) > NEW_THREAD_DRAFT_MAX_BYTES;
      publish({
        text,
        ...(oversized ? { warning: "too-large" as const } : {}),
      });
      if (text === "") {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        remove();
        persistedUpdatedAt = 0;
        return;
      }
      if (oversized) {
        if (timer !== undefined) clearTimeout(timer);
        timer = undefined;
        remove();
        persistedUpdatedAt = 0;
        return;
      }
      timer = setTimeout(flush, debounceMs);
    },
    flush,
    clear: () => {
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      persistedUpdatedAt = 0;
      locallyEditedAt = 0;
      remove();
      publish(emptySnapshot);
    },
  };
};

const browserStores = new Map<string, NewThreadDraftStore>();
export const getBrowserNewThreadDraftStore = (scope: NewThreadDraftScope) => {
  const key = scopeKey(scope);
  let store = browserStores.get(key);
  if (store !== undefined) return store;
  let storage: Storage | undefined;
  try {
    storage = typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    storage = undefined;
  }
  store = createNewThreadDraftStore({
    scope,
    storage,
    subscribeToStorage:
      typeof window === "undefined"
        ? undefined
        : (listener) => {
            const handle = (event: StorageEvent) =>
              listener(event.key, event.newValue);
            window.addEventListener("storage", handle);
            return () => window.removeEventListener("storage", handle);
          },
    subscribeToPageHide:
      typeof window === "undefined"
        ? undefined
        : (listener) => {
            window.addEventListener("pagehide", listener);
            return () => window.removeEventListener("pagehide", listener);
          },
  });
  browserStores.set(key, store);
  return store;
};

export const clearNewThreadDraftsForUser = (userId: UserId) => {
  if (typeof window === "undefined") return;
  const prefix = `${newThreadDraftStoragePrefix}${encodeURIComponent(userId)}:`;
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index -= 1) {
      const key = storage.key(index);
      if (key?.startsWith(prefix)) storage.removeItem(key);
    }
  } catch {
    // Signing out must continue even when browser storage is unavailable.
  }
  try {
    for (const [key, store] of browserStores)
      if (key.startsWith(prefix)) {
        try {
          store.clear();
        } catch {
          // A cached adapter must not make sign-out cleanup partial or throwing.
        }
      }
  } catch {
    // Keep this best-effort privacy cleanup total.
  }
};
