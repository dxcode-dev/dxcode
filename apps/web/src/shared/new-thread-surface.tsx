import type { ProjectId, ThreadId, ThreadTitle } from "@dx/domain";
import * as React from "react";

/** An email in the person's Mail that a new Thread starts from. */
export interface ComposerEmail {
  readonly mailId: string;
  readonly subject: string;
  /** Who sent it: their name, or their address when it has none. */
  readonly from: string;
}

export interface NewThreadSurfaceValue {
  /**
   * Opens the composer, optionally in a Project with a prompt filled in, or
   * on an email it starts from (Start thread in Mail).
   */
  readonly openNewThread: (
    projectId?: ProjectId,
    prompt?: string,
    email?: ComposerEmail,
  ) => void;
  /** A stable snapshot; it changes only when a creation starts or ends. */
  readonly pendingCreations?: () => ReadonlyArray<PendingThreadCreation>;
  readonly subscribePendingCreations?: (listener: () => void) => () => void;
}

/** A Thread this browser sent and Flue has not shown yet. */
export interface PendingThreadCreation {
  readonly id: ThreadId;
  /** Absent for No Project. */
  readonly project?: { readonly id: ProjectId };
  readonly title: ThreadTitle;
  /** Epoch milliseconds when the user sent it. */
  readonly startedAt: number;
  /** Set once Core admitted it; from then the server's list owns its row. */
  readonly submissionId?: string;
}

const unavailableNewThreadSurface: NewThreadSurfaceValue = {
  openNewThread: () => undefined,
};

export const NewThreadSurfaceContext =
  React.createContext<NewThreadSurfaceValue>(unavailableNewThreadSurface);

export function useNewThreadSurface() {
  return React.useContext(NewThreadSurfaceContext);
}
