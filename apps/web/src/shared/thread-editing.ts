import type { ThreadData } from "@dx/api";
import type { ThreadColor, ThreadId } from "@dx/domain";
import * as React from "react";

/** Rename, recolor, pin, and delete a Thread the requester owns. */
export interface ThreadEditingController {
  readonly openRename: (thread: Pick<ThreadData, "id" | "title">) => void;
  /**
   * Asks to confirm, then deletes the Thread with its sandbox. `children`,
   * the count listed under it, deletes those child Threads too.
   */
  readonly openDelete: (
    thread: Pick<ThreadData, "id" | "title">,
    children?: number,
  ) => void;
  /** `null` returns the Thread to its auto color. */
  readonly setColor: (threadId: ThreadId, color: ThreadColor | null) => void;
  /** How many child Threads the sidebar lists under it, read when asked. */
  readonly childCount: (threadId: ThreadId) => number;
  /** Whether the sidebar lists the Thread as pinned, read when asked. */
  readonly pinned: (threadId: ThreadId) => boolean;
  readonly setPinned: (threadId: ThreadId, pinned: boolean) => void;
}

export const ThreadEditingContext = React.createContext<
  ThreadEditingController | undefined
>(undefined);

export const useOptionalThreadEditing = () =>
  React.useContext(ThreadEditingContext);
