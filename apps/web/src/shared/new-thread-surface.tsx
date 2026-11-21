import type { ProjectId, ThreadId, ThreadTitle } from "@dx/domain";
import * as React from "react";

/** An email in the person's Mail that a new Thread starts from. */
export interface ComposerEmail {
  readonly mailId: string;
  readonly subject: string;
  /** Who sent it: their name, or their address when it has none. */
  readonly from: string;
}

export type OpenNewThread = (
  projectId?: ProjectId,
  prompt?: string,
  email?: ComposerEmail,
) => void;

/** Focuses a composer already on the page, in a Project or with a prompt. */
export type FocusNewThread = (projectId?: ProjectId, prompt?: string) => void;

export interface NewThreadSurfaceValue {
  /**
   * Opens the composer, optionally in a Project with a prompt filled in, or
   * on an email it starts from (Start thread in Mail).
   */
  readonly openNewThread: OpenNewThread;
  /**
   * Makes `focus` the composer `openNewThread` reaches until the returned
   * function is called: a page that shows the composer inline (the home
   * page on a wide screen) takes "new Thread" instead of the dialog.
   * Absent outside the product shell.
   */
  readonly registerInlineNewThread?: (focus: FocusNewThread) => () => void;
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

/**
 * Routes "new Thread" (the New Thread button, its shortcut, the palette) to
 * a composer shown inline on the page when there is one, and otherwise to
 * `openDialog`. A Thread started from an email always opens the dialog,
 * which shows the email it starts from.
 */
export function useInlineNewThreadRouting(openDialog: OpenNewThread) {
  const inline = React.useRef<FocusNewThread | undefined>(undefined);
  const openNewThread: OpenNewThread = (projectId, prompt, email) => {
    if (inline.current === undefined || email !== undefined)
      openDialog(projectId, prompt, email);
    else inline.current(projectId, prompt);
  };
  const registerInlineNewThread = (focus: FocusNewThread) => {
    inline.current = focus;
    return () => {
      if (inline.current === focus) inline.current = undefined;
    };
  };
  return { openNewThread, registerInlineNewThread };
}
