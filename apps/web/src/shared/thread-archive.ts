import type { ThreadId } from "@dx/domain";
import * as React from "react";

export interface ThreadArchiveController {
  readonly pendingArchived?: boolean;
  readonly pendingThreadId?: ThreadId;
  readonly setArchived: (threadId: ThreadId, archived: boolean) => void;
}

export const ThreadArchiveContext = React.createContext<
  ThreadArchiveController | undefined
>(undefined);

export const useOptionalThreadArchive = () =>
  React.useContext(ThreadArchiveContext);

export function useThreadArchive() {
  const controller = React.useContext(ThreadArchiveContext);
  if (controller === undefined)
    throw new Error(
      "useThreadArchive must be used inside ThreadArchiveProvider.",
    );
  return controller;
}
