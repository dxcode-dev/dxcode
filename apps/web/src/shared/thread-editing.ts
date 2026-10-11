import type { ThreadData } from "@dx/api";
import type { ThreadColor, ThreadId } from "@dx/domain";
import * as React from "react";

/** Rename and recolor a Thread the requester owns. */
export interface ThreadEditingController {
  readonly openRename: (thread: Pick<ThreadData, "id" | "title">) => void;
  /** `null` returns the Thread to its auto color. */
  readonly setColor: (threadId: ThreadId, color: ThreadColor | null) => void;
}

export const ThreadEditingContext = React.createContext<
  ThreadEditingController | undefined
>(undefined);

export const useOptionalThreadEditing = () =>
  React.useContext(ThreadEditingContext);
