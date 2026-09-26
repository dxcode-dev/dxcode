import type { ProjectId, ThreadId } from "@dx/domain";
import * as React from "react";

export interface NewThreadSurfaceValue {
  readonly openNewThread: (projectId?: ProjectId) => void;
  readonly pendingProjectlessCreation?: (
    threadId: string,
  ) => PendingProjectlessCreation | undefined;
  readonly subscribePendingProjectlessCreation?: (
    listener: () => void,
  ) => () => void;
}

export interface PendingProjectlessCreation {
  readonly id: ThreadId;
}

const unavailableNewThreadSurface: NewThreadSurfaceValue = {
  openNewThread: () => undefined,
};

export const NewThreadSurfaceContext =
  React.createContext<NewThreadSurfaceValue>(unavailableNewThreadSurface);

export function useNewThreadSurface() {
  return React.useContext(NewThreadSurfaceContext);
}
