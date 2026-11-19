import type { ThreadDraftSlot, WorkspaceDraftSlot } from "@dx/api";
import type { ThreadId, UserId, WorkspaceId } from "@dx/domain";
import {
  type QueryClient,
  QueryObserver,
  queryOptions,
  useQueryClient,
} from "@tanstack/react-query";
import { getComposerDraft, putComposerDraft } from "../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import type { PresentationValue } from "./use-thread-presentation.js";

/** How long after the last keystroke a draft is written to Core. */
export const THREAD_DRAFT_SAVE_DELAY_MS = 500;

/**
 * Which composer a draft belongs to: a Thread's own (a Space's included), a
 * box inside a Thread the slot names (a post's comments, an artifact's new
 * comment or a reply), or New Thread and New Space in a workspace, or
 * `personal` outside any.
 */
export type DraftAddress =
  | { readonly threadId: ThreadId; readonly slot?: ThreadDraftSlot }
  | {
      readonly workspace: WorkspaceId | "personal";
      readonly slot: WorkspaceDraftSlot;
    };

const addressKey = (address: DraftAddress) =>
  "threadId" in address
    ? address.slot === undefined
      ? address.threadId
      : `${address.threadId}?${address.slot}`
    : `workspace:${address.workspace}:${address.slot}`;

export const threadDraftKeys = {
  draft: (userId: UserId, address: ThreadId | DraftAddress) =>
    [
      "thread-draft",
      userId,
      typeof address === "string" ? address : addressKey(address),
    ] as const,
};

const asAddress = (address: ThreadId | DraftAddress): DraftAddress =>
  typeof address === "string" ? { threadId: address } : address;

const loadDraft = (address: DraftAddress, signal?: AbortSignal) =>
  getComposerDraft(address, signal);

const storeDraft = (address: DraftAddress, text: string, keepalive: boolean) =>
  putComposerDraft(address, text, keepalive);

interface UnsavedDraft {
  readonly address: DraftAddress;
  readonly text: string;
  timer: ReturnType<typeof setTimeout> | undefined;
}

/**
 * Edits Core does not have yet, by person and composer. A fetch answers with
 * them rather than with the older text it read, so a refetch never undoes
 * typing.
 */
const unsaved = new Map<string, UnsavedDraft>();
const unsavedKey = (userId: UserId, address: DraftAddress) =>
  `${userId}:${addressKey(address)}`;

/**
 * The person's unsent text in one composer, kept in Core so each of their
 * devices shows it. Read again whenever a composer opens it or the window
 * regains focus; the last write wins.
 */
export const threadDraftQueryOptions = (
  userId: UserId,
  target: ThreadId | DraftAddress,
) => {
  const address = asAddress(target);
  return queryOptions({
    queryKey: threadDraftKeys.draft(userId, address),
    queryFn: async ({ signal }) => {
      const key = unsavedKey(userId, address);
      const before = writes.get(key);
      const startedBefore = before?.started ?? 0;
      const writingBefore = (before?.inFlight ?? 0) > 0;
      const saved = await loadDraft(address, signal);
      const pending = unsaved.get(key);
      if (pending !== undefined) return pending.text;
      // A save crossed this read, so Core may have read before the save
      // reached it: the text this page wrote last is newer.
      const after = writes.get(key);
      return after !== undefined &&
        (writingBefore || after.started !== startedBefore)
        ? after.text
        : saved;
    },
    staleTime: 0,
    refetchOnWindowFocus: true,
    retry: 1,
  });
};

/** The saves this page started for one person and composer. */
interface DraftWrites {
  /** How many started; a read that sees this change crossed a save. */
  started: number;
  /** How many have not finished. */
  inFlight: number;
  /** What the latest one wrote. */
  text: string;
  /** The latest one; the next waits for it, so Core gets them in order. */
  last: Promise<void>;
}

const writes = new Map<string, DraftWrites>();

const save = (key: string, draft: UnsavedDraft, keepalive = false) => {
  let thread = writes.get(key);
  if (thread === undefined) {
    thread = { started: 0, inFlight: 0, text: "", last: Promise.resolve() };
    writes.set(key, thread);
  }
  const current = thread;
  current.started += 1;
  current.inFlight += 1;
  current.text = draft.text;
  const put = () =>
    storeDraft(draft.address, draft.text, keepalive)
      .then(
        () => {
          if (unsaved.get(key) === draft) unsaved.delete(key);
        },
        () => {
          // Kept as unsaved: the next edit, or the page hiding, tries again.
        },
      )
      .finally(() => {
        current.inFlight -= 1;
      });
  // A save as the page unloads cannot wait its turn; it carries the latest
  // text, sent after any save still in flight.
  current.last = keepalive ? put() : current.last.then(put);
  return current.last;
};

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
 * Sets the composer's draft and schedules the write. `""`, as when the
 * message is sent, removes it from Core as soon as earlier saves finish. A
 * load still in flight is cancelled so it cannot replace what the person
 * typed.
 */
export const setThreadDraft = (
  client: QueryClient,
  userId: UserId,
  target: ThreadId | DraftAddress,
  text: string,
) => {
  const address = asAddress(target);
  const queryKey = threadDraftKeys.draft(userId, address);
  const key = unsavedKey(userId, address);
  const pending = unsaved.get(key);
  if (pending === undefined && client.getQueryData(queryKey) === text) return;
  if (pending?.timer !== undefined) clearTimeout(pending.timer);
  void client.cancelQueries({ queryKey, exact: true });
  client.setQueryData(queryKey, text);
  const draft: UnsavedDraft = { address, text, timer: undefined };
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

/** Writes every unsaved draft now, as a composer closes. */
export const flushUnsavedThreadDrafts = () => {
  for (const [key, draft] of unsaved) {
    if (draft.timer === undefined) continue;
    clearTimeout(draft.timer);
    draft.timer = undefined;
    void save(key, draft);
  }
};

/** Drops unsaved drafts without writing them, when the person signs out. */
export const discardUnsavedThreadDrafts = () => {
  for (const draft of unsaved.values())
    if (draft.timer !== undefined) clearTimeout(draft.timer);
  unsaved.clear();
  writes.clear();
};

const values = new WeakMap<
  QueryClient,
  Map<string, PresentationValue<string>>
>();

/**
 * The composer's draft as a value a composer subscribes to. Subscribing loads
 * it from Core; an owner can pass it down without re-rendering on each edit.
 */
export const threadDraftValue = (
  client: QueryClient,
  userId: UserId,
  target: ThreadId | DraftAddress,
): PresentationValue<string> => {
  const address = asAddress(target);
  let byThread = values.get(client);
  if (byThread === undefined) {
    byThread = new Map();
    values.set(client, byThread);
  }
  const key = unsavedKey(userId, address);
  const existing = byThread.get(key);
  if (existing !== undefined) return existing;
  const queryKey = threadDraftKeys.draft(userId, address);
  const value: PresentationValue<string> = {
    get: () => client.getQueryData<string>(queryKey) ?? "",
    set: (text) => setThreadDraft(client, userId, address, text),
    subscribe: (listener) =>
      new QueryObserver(
        client,
        threadDraftQueryOptions(userId, address),
      ).subscribe(() => listener()),
  };
  byThread.set(key, value);
  return value;
};

/** The signed-in person's draft for the Thread, without subscribing to it. */
export function useThreadDraftValue(target: ThreadId | DraftAddress) {
  const client = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  return threadDraftValue(client, identity.id, target);
}
