import type { ThreadId, UserId } from "@dx/domain";
import {
  type QueryClient,
  QueryObserver,
  queryOptions,
  useQueryClient,
} from "@tanstack/react-query";
import { getThreadDraft, putThreadDraft } from "../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { PresentationValue } from "./use-thread-presentation.js";

/** How long after the last keystroke a Thread's draft is written to Core. */
export const THREAD_DRAFT_SAVE_DELAY_MS = 500;

export const threadDraftKeys = {
  draft: (userId: UserId, threadId: ThreadId) =>
    ["thread-draft", userId, threadId] as const,
};

interface UnsavedDraft {
  readonly threadId: ThreadId;
  readonly text: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Edits Core does not have yet, by person and Thread. A fetch answers with
 * them rather than with the older text it read, so a refetch never undoes
 * typing.
 */
const unsaved = new Map<string, UnsavedDraft>();
const unsavedKey = (userId: UserId, threadId: ThreadId) =>
  `${userId}:${threadId}`;

/**
 * The person's unsent message in one Thread's composer, kept in Core so each
 * of their devices shows it. Read again whenever a composer opens it or the
 * window regains focus; the last write wins.
 */
export const threadDraftQueryOptions = (userId: UserId, threadId: ThreadId) =>
  queryOptions({
    queryKey: threadDraftKeys.draft(userId, threadId),
    queryFn: async ({ signal }) => {
      const saved = await getThreadDraft(threadId, signal);
      return unsaved.get(unsavedKey(userId, threadId))?.text ?? saved;
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: 1,
  });

const save = (key: string, draft: UnsavedDraft, keepalive = false) =>
  putThreadDraft(draft.threadId, draft.text, { keepalive }).then(
    () => {
      if (unsaved.get(key) === draft) unsaved.delete(key);
    },
    () => {
      // Kept as unsaved: the next edit, or the page hiding, tries again.
    },
  );

/** Writes every unsaved draft now; the page may be about to unload. */
const flushUnsaved = () => {
  // Includes failed and in-flight writes: a repeated write is harmless.
  for (const [key, draft] of unsaved) {
    if (draft.timer !== undefined) clearTimeout(draft.timer);
    draft.timer = undefined;
    void save(key, draft, true);
  }
};

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "hidden") flushUnsaved();
  });
  window.addEventListener("pagehide", flushUnsaved);
}

/**
 * Sets the Thread's draft and schedules the write. `""`, as when the message
 * is sent, removes it from Core at once. A load still in flight is cancelled
 * so it cannot replace what the person typed.
 */
export const setThreadDraft = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
  text: string,
) => {
  const queryKey = threadDraftKeys.draft(userId, threadId);
  const key = unsavedKey(userId, threadId);
  const pending = unsaved.get(key);
  if (pending === undefined && client.getQueryData(queryKey) === text) return;
  if (pending?.timer !== undefined) clearTimeout(pending.timer);
  void client.cancelQueries({ queryKey, exact: true });
  client.setQueryData(queryKey, text);
  const draft: UnsavedDraft = { threadId, text, timer: undefined };
  unsaved.set(key, draft);
  if (text === "") {
    void save(key, draft);
    return;
  }
  draft.timer = setTimeout(() => {
    draft.timer = undefined;
    void save(key, draft);
  }, THREAD_DRAFT_SAVE_DELAY_MS);
};

/** Drops unsaved drafts without writing them, when the person signs out. */
export const discardUnsavedThreadDrafts = () => {
  for (const draft of unsaved.values())
    if (draft.timer !== undefined) clearTimeout(draft.timer);
  unsaved.clear();
};

const values = new WeakMap<
  QueryClient,
  Map<string, PresentationValue<string>>
>();

/**
 * The Thread's draft as a value a composer subscribes to. Subscribing loads
 * it from Core; an owner can pass it down without re-rendering on each edit.
 */
export const threadDraftValue = (
  client: QueryClient,
  userId: UserId,
  threadId: ThreadId,
): PresentationValue<string> => {
  let byThread = values.get(client);
  if (byThread === undefined) {
    byThread = new Map();
    values.set(client, byThread);
  }
  const key = unsavedKey(userId, threadId);
  const existing = byThread.get(key);
  if (existing !== undefined) return existing;
  const queryKey = threadDraftKeys.draft(userId, threadId);
  const value: PresentationValue<string> = {
    get: () => client.getQueryData<string>(queryKey) ?? "",
    set: (text) => setThreadDraft(client, userId, threadId, text),
    subscribe: (listener) =>
      new QueryObserver(
        client,
        threadDraftQueryOptions(userId, threadId),
      ).subscribe(() => listener()),
  };
  byThread.set(key, value);
  return value;
};

/** The signed-in person's draft for the Thread, without subscribing to it. */
export function useThreadDraftValue(threadId: ThreadId) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  return threadDraftValue(client, identity.id, threadId);
}
