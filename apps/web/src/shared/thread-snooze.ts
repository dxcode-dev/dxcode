import type { ThreadId } from "@dx/domain";
import * as React from "react";

/** Snoozes and wakes Threads the requester owns. */
export interface ThreadSnoozeController {
  readonly pendingThreadId?: ThreadId;
  /** Snoozes the Thread until `wakeAt` and offers Undo. */
  readonly snooze: (threadId: ThreadId, wakeAt: Date) => void;
  /** Opens the dialog for a wake time the menu does not list. */
  readonly snoozeCustom: (threadId: ThreadId) => void;
  /** Wakes a snoozed Thread now, or clears a woken Thread's mark. */
  readonly wake: (threadId: ThreadId) => void;
}

export const ThreadSnoozeContext = React.createContext<
  ThreadSnoozeController | undefined
>(undefined);

export const useOptionalThreadSnooze = () =>
  React.useContext(ThreadSnoozeContext);
