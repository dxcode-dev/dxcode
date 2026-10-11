import { Schema } from "effect";

/**
 * Whether this browser dismissed the one-time "Connect your Claude
 * subscription" notice on Model Routing. A device preference: dismissing it
 * on one device leaves it visible on another until the plan is connected.
 */
export const claudeCodeNoticeStorageKey = "dx:claude-code-notice:v1";

const NoticeEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  dismissedAt: Schema.Number,
});

export interface ClaudeCodeNoticeStore {
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => boolean;
  readonly getServerSnapshot: () => boolean;
  readonly dismiss: () => void;
}

const decodeDismissed = (raw: string | null) => {
  if (raw === null) return false;
  try {
    Schema.decodeUnknownSync(NoticeEnvelope)(JSON.parse(raw));
    return true;
  } catch {
    return false;
  }
};

export const createClaudeCodeNoticeStore = (
  storage: Storage | undefined,
  now: () => number = Date.now,
): ClaudeCodeNoticeStore => {
  const listeners = new Set<() => void>();
  const read = () => {
    try {
      return decodeDismissed(
        storage?.getItem(claudeCodeNoticeStorageKey) ?? null,
      );
    } catch {
      return false;
    }
  };
  let dismissed = read();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== null && event.key !== claudeCodeNoticeStorageKey) return;
    dismissed = read();
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
    getSnapshot: () => dismissed,
    getServerSnapshot: () => false,
    dismiss: () => {
      dismissed = true;
      try {
        storage?.setItem(
          claudeCodeNoticeStorageKey,
          JSON.stringify({ version: 1, dismissedAt: now() }),
        );
      } catch {
        // Storage may be full or disabled; the notice stays hidden this session.
      }
      notify();
    },
  };
};

let browserStore: ClaudeCodeNoticeStore | undefined;

/** Reading `localStorage` itself throws where storage is blocked. */
const browserStorage = (): Storage | undefined => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

export const getBrowserClaudeCodeNoticeStore = () => {
  browserStore ??= createClaudeCodeNoticeStore(browserStorage());
  return browserStore;
};
