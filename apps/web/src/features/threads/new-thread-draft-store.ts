import type { NewThreadCreation } from "@dx/client";
import type { UserId, WorkspaceId } from "@dx/domain";
import { DictationRecoverySession } from "./dictation/dictation-session.js";
import {
  createPendingAttachmentCollection,
  type PendingAttachment,
  type PendingAttachmentCollection,
} from "./image-attachments.js";

/** The longest prompt Core keeps; a longer one stays open but unsaved. */
export const NEW_THREAD_DRAFT_MAX_BYTES = 64 * 1024;
/**
 * Where this browser kept New Thread drafts before Core did. A draft left
 * there moves to Core the first time its composer opens, then goes.
 */
export const newThreadDraftStoragePrefix = "dx:new-thread-draft:v1:";

export interface NewThreadDraftScope {
  readonly userId: UserId;
  readonly workspaceId: WorkspaceId | "personal";
}
export interface NewThreadDraftSnapshot {
  readonly text: string;
  readonly warning?: "too-large";
}

/**
 * Where the prompt's text lives: the person's New Thread draft in Core (see
 * thread-draft-queries), so a reload or another device shows it. Subscribing
 * loads it; `loaded` says whether Core's text has arrived.
 */
export interface NewThreadDraftText {
  readonly get: () => string;
  readonly set: (text: string) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly loaded: () => boolean;
  /** Writes an unsaved edit now; the composer is closing. */
  readonly flush: () => void;
}
/** A New Thread request as sent, and the Thread it creates. */
export type {
  InitialThreadCreationAttempt,
  NewThreadCreation,
} from "@dx/client";

export interface NewThreadDraftStore {
  readonly dictation: DictationRecoverySession;
  /**
   * Files added to the composer. Like dictation audio they stay in memory,
   * never in browser storage, so they outlive the composer but not the page.
   */
  readonly images: PendingAttachmentCollection;
  readonly getImages: () => ReadonlyArray<PendingAttachment>;
  readonly setImages: (images: ReadonlyArray<PendingAttachment>) => void;
  readonly subscribe: (listener: () => void) => () => void;
  readonly getSnapshot: () => NewThreadDraftSnapshot;
  readonly getServerSnapshot: () => NewThreadDraftSnapshot;
  readonly setText: (text: string) => void;
  /**
   * Adds an opener's prompt after the saved draft, once Core's draft has
   * arrived, unless the draft already holds it.
   */
  readonly appendPrompt: (prompt: string) => void;
  readonly flush: () => void;
  readonly clear: () => void;
  readonly getCreation: () => NewThreadCreation;
  readonly setCreation: (creation: NewThreadCreation) => void;
}

const emptySnapshot: NewThreadDraftSnapshot = { text: "" };
const noCreation: NewThreadCreation = { sending: false, stalled: false };
const noImages: ReadonlyArray<PendingAttachment> = [];
const utf8Size = (text: string) => new TextEncoder().encode(text).byteLength;
const scopeKey = ({ userId, workspaceId }: NewThreadDraftScope) =>
  `${newThreadDraftStoragePrefix}${encodeURIComponent(userId)}:${encodeURIComponent(workspaceId)}`;

/** Text that lives only as long as the page: for tests and previews. */
export const mountScopedDraftText = (): NewThreadDraftText => {
  let text = "";
  const listeners = new Set<() => void>();
  return {
    get: () => text,
    set: (next) => {
      if (next === text) return;
      text = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    loaded: () => true,
    flush: () => {},
  };
};

/** The prompt this browser kept before Core did, if it is still fresh. */
const readLegacyDraft = (
  storage: Storage | undefined,
  key: string,
  now: number,
): string | undefined => {
  try {
    const raw = storage?.getItem(key);
    if (raw === null || raw === undefined) return undefined;
    const value = JSON.parse(raw) as {
      readonly text?: unknown;
      readonly expiresAt?: unknown;
    };
    return typeof value.text === "string" &&
      value.text !== "" &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > now
      ? value.text
      : undefined;
  } catch {
    return undefined;
  }
};

export const createNewThreadDraftStore = ({
  text = mountScopedDraftText(),
  legacyText,
  onLegacySettled,
  images = createPendingAttachmentCollection(),
}: {
  readonly scope?: NewThreadDraftScope;
  readonly text?: NewThreadDraftText;
  /** A prompt this browser kept before Core did: Core takes it if empty. */
  readonly legacyText?: string | undefined;
  /** Core has the legacy prompt, or had its own: the browser's copy can go. */
  readonly onLegacySettled?: () => void;
  readonly images?: PendingAttachmentCollection;
}): NewThreadDraftStore => {
  const listeners = new Set<() => void>();
  let unsubscribeText: (() => void) | undefined;
  // A prompt too long for Core stays here, unsaved, while the page lasts.
  let oversized: string | undefined;
  let snapshot = emptySnapshot;
  let imageList = noImages;
  let creation = noCreation;
  let legacy = legacyText;
  let pendingPrompt: string | undefined;

  const notify = () => {
    for (const listener of listeners) listener();
  };
  const getSnapshot = () => {
    const current = oversized ?? text.get();
    const warning = oversized === undefined ? undefined : "too-large";
    if (snapshot.text !== current || snapshot.warning !== warning)
      snapshot =
        warning === undefined ? { text: current } : { text: current, warning };
    return snapshot;
  };
  const setText = (next: string) => {
    if (utf8Size(next) > NEW_THREAD_DRAFT_MAX_BYTES) {
      oversized = next;
      notify();
      return;
    }
    const wasOversized = oversized !== undefined;
    oversized = undefined;
    text.set(next);
    if (wasOversized) notify();
  };
  // Once Core's draft is here: an old browser-kept prompt fills an empty
  // one, and an opener's prompt joins it.
  const settle = () => {
    if (!text.loaded()) return;
    if (legacy !== undefined) {
      const kept = legacy;
      legacy = undefined;
      if (text.get() === "") text.set(kept);
      onLegacySettled?.();
    }
    if (pendingPrompt !== undefined) {
      const prompt = pendingPrompt;
      pendingPrompt = undefined;
      const saved = (oversized ?? text.get()).trimEnd();
      if (!saved.includes(prompt))
        setText(saved === "" ? prompt : `${saved}\n\n${prompt}`);
    }
  };

  const setImages = (next: ReadonlyArray<PendingAttachment>) => {
    if (imageList === next) return;
    imageList = next;
    notify();
  };
  const setCreation = (next: NewThreadCreation) => {
    if (creation === next) return;
    creation = next;
    notify();
  };

  return {
    dictation: new DictationRecoverySession(),
    images,
    getImages: () => imageList,
    setImages,
    subscribe: (listener) => {
      listeners.add(listener);
      if (listeners.size === 1) {
        unsubscribeText = text.subscribe(() => {
          settle();
          notify();
        });
        settle();
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0) {
          unsubscribeText?.();
          unsubscribeText = undefined;
        }
      };
    },
    getSnapshot,
    getServerSnapshot: () => emptySnapshot,
    setText,
    appendPrompt: (prompt) => {
      pendingPrompt = prompt;
      settle();
    },
    flush: () => text.flush(),
    clear: () => {
      oversized = undefined;
      pendingPrompt = undefined;
      text.set("");
      notify();
      // A sent Thread took its files first; anything left is discarded.
      images.dispose();
      setImages(noImages);
      setCreation(noCreation);
    },
    getCreation: () => creation,
    setCreation,
  };
};

const browserStorage = () => {
  try {
    return typeof window === "undefined" ? undefined : window.localStorage;
  } catch {
    return undefined;
  }
};

const browserStores = new Map<string, NewThreadDraftStore>();
/**
 * The person's New Thread composer in one workspace: its text from Core,
 * and its files, dictation, and send held while the page lasts.
 */
export const getBrowserNewThreadDraftStore = (
  scope: NewThreadDraftScope,
  text: NewThreadDraftText,
) => {
  const key = scopeKey(scope);
  let store = browserStores.get(key);
  if (store !== undefined) return store;
  store = createNewThreadDraftStore({
    scope,
    text,
    legacyText: readLegacyDraft(browserStorage(), key, Date.now()),
    onLegacySettled: () => {
      try {
        browserStorage()?.removeItem(key);
      } catch {
        // Blocked storage keeps nothing to forget.
      }
    },
  });
  browserStores.set(key, store);
  return store;
};

/**
 * The composer Start thread opens on one email: its own prompt, files, and
 * send, held while the page lasts, so the person's New Thread draft is left
 * as it was and a resend reuses the Thread this email started.
 */
export const getBrowserEmailThreadDraftStore = (
  userId: UserId,
  mailId: string,
) => {
  const key = `${newThreadDraftStoragePrefix}${encodeURIComponent(userId)}:mail:${encodeURIComponent(mailId)}`;
  let store = browserStores.get(key);
  if (store !== undefined) return store;
  store = createNewThreadDraftStore({});
  browserStores.set(key, store);
  return store;
};

/**
 * Forgets the person's composers on this page as they sign out. Their
 * drafts stay in Core for their next sign-in, as a Thread's do.
 */
export const clearNewThreadDraftsForUser = (userId: UserId) => {
  const prefix = `${newThreadDraftStoragePrefix}${encodeURIComponent(userId)}:`;
  try {
    const storage = browserStorage();
    if (storage !== undefined)
      for (let index = storage.length - 1; index >= 0; index -= 1) {
        const key = storage.key(index);
        if (key?.startsWith(prefix)) storage.removeItem(key);
      }
  } catch {
    // Signing out must continue even when browser storage is unavailable.
  }
  for (const [key, store] of browserStores)
    if (key.startsWith(prefix)) {
      try {
        store.dictation.clear();
        store.images.dispose();
      } catch {
        // A cached adapter must not make sign-out cleanup partial or throwing.
      }
      browserStores.delete(key);
    }
};
