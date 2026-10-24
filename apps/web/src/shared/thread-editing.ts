import type { ThreadData } from "@dx/api";
import type { ThreadColor, ThreadId } from "@dx/domain";
import * as React from "react";

/** Rename, recolor, pin, and delete a Thread the requester owns. */
export interface ThreadEditingController {
  readonly openRename: (thread: Pick<ThreadData, "id" | "title">) => void;
  /** Asks to confirm, then deletes the Thread with its sandbox. */
  readonly openDelete: (thread: Pick<ThreadData, "id" | "title">) => void;
  /** `null` returns the Thread to its auto color. */
  readonly setColor: (threadId: ThreadId, color: ThreadColor | null) => void;
  /** Whether the sidebar lists the Thread as pinned, read when asked. */
  readonly pinned: (threadId: ThreadId) => boolean;
  readonly setPinned: (threadId: ThreadId, pinned: boolean) => void;
}

export const ThreadEditingContext = React.createContext<
  ThreadEditingController | undefined
>(undefined);

export const useOptionalThreadEditing = () =>
  React.useContext(ThreadEditingContext);
