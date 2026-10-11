import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore, LoaderCircle, X } from "lucide-react";
import * as React from "react";
import type { ArchivedThread } from "../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadArchiveContext,
  type ThreadArchiveController,
} from "../../shared/thread-archive.js";
import { Button } from "../../shared/ui/button.js";
import { setThreadArchivedMutationOptions } from "./thread-mutations.js";

interface ArchiveNotice {
  readonly kind: "progress" | "success" | "error";
  readonly message: string;
  readonly undoThreadId?: ThreadId;
  /** The children the archive changed, which Undo restores with it. */
  readonly undoChildThreadIds?: ReadonlyArray<ThreadId>;
}

export function ThreadArchiveProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    setThreadArchivedMutationOptions(queryClient, identity.id),
  );
  const { isPending, mutate, variables } = mutation;
  const [notice, setNotice] = React.useState<ArchiveNotice>();
  const dismissTimer = React.useRef<number | undefined>(undefined);
  const mutationPending = React.useRef(false);

  const dismiss = React.useCallback(() => {
    if (dismissTimer.current !== undefined)
      window.clearTimeout(dismissTimer.current);
    dismissTimer.current = undefined;
    setNotice(undefined);
  }, []);

  const showTemporary = React.useCallback((next: ArchiveNotice) => {
    if (dismissTimer.current !== undefined)
      window.clearTimeout(dismissTimer.current);
    setNotice(next);
    dismissTimer.current = window.setTimeout(() => {
      dismissTimer.current = undefined;
      setNotice(undefined);
    }, 6_000);
  }, []);

  const noticeLifetimeRef = React.useCallback((node: HTMLDivElement | null) => {
    if (node === null) return;
    return () => {
      if (dismissTimer.current !== undefined)
        window.clearTimeout(dismissTimer.current);
      dismissTimer.current = undefined;
    };
  }, []);

  /**
   * `children`: true for every child in the parent's former state, or the
   * exact children an Undo restores.
   */
  const changeArchived = React.useCallback(
    (
      threadId: ThreadId,
      archived: boolean,
      children?: true | ReadonlyArray<ThreadId>,
    ) => {
      const includeChildren = children !== undefined;
      if (mutationPending.current) return;
      mutationPending.current = true;
      if (dismissTimer.current !== undefined)
        window.clearTimeout(dismissTimer.current);
      dismissTimer.current = undefined;
      setNotice({
        kind: "progress",
        message: archived
          ? includeChildren
            ? "Archiving threads…"
            : "Archiving thread…"
          : "Unarchiving thread…",
      });
      mutate(
        children === undefined
          ? { threadId, archived }
          : { threadId, archived, children },
        {
          onSuccess: ({ thread, changedChildThreadIds }: ArchivedThread) =>
            showTemporary({
              kind: "success",
              message: archived
                ? includeChildren
                  ? "Archived threads"
                  : "Archived thread"
                : "Unarchived thread",
              ...(archived
                ? {
                    undoThreadId: thread.id,
                    ...(changedChildThreadIds === undefined ||
                    changedChildThreadIds.length === 0
                      ? {}
                      : { undoChildThreadIds: changedChildThreadIds }),
                  }
                : {}),
            }),
          onError: (cause) =>
            showTemporary({
              kind: "error",
              message:
                cause instanceof Error
                  ? cause.message
                  : archived
                    ? "Thread could not be archived."
                    : "Thread could not be unarchived.",
            }),
          onSettled: () => {
            mutationPending.current = false;
          },
        },
      );
    },
    [mutate, showTemporary],
  );

  const setArchived = React.useCallback(
    (threadId: ThreadId, archived: boolean, includeChildren = false) =>
      changeArchived(threadId, archived, includeChildren ? true : undefined),
    [changeArchived],
  );

  const controller = React.useMemo<ThreadArchiveController>(
    () => ({
      setArchived,
      pendingThreadId: isPending ? variables.threadId : undefined,
      pendingArchived: isPending ? variables.archived : undefined,
    }),
    [isPending, setArchived, variables],
  );

  return (
    <ThreadArchiveContext.Provider value={controller}>
      {children}
      {notice === undefined ? null : (
        <div
          className="thread-archive-toast"
          role={notice.kind === "error" ? "alert" : "status"}
          aria-live="polite"
          ref={noticeLifetimeRef}
        >
          {notice.kind === "progress" ? (
            <LoaderCircle className="spin" aria-hidden="true" />
          ) : notice.undoThreadId === undefined ? (
            <ArchiveRestore aria-hidden="true" />
          ) : (
            <Archive aria-hidden="true" />
          )}
          <strong>{notice.message}</strong>
          {notice.undoThreadId === undefined ? null : (
            <button
              type="button"
              onClick={() => {
                if (notice.undoThreadId !== undefined)
                  changeArchived(
                    notice.undoThreadId,
                    false,
                    notice.undoChildThreadIds,
                  );
              }}
            >
              Undo
            </button>
          )}
          {notice.kind === "progress" ? null : (
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Dismiss notification"
              onClick={dismiss}
            >
              <X />
            </Button>
          )}
        </div>
      )}
    </ThreadArchiveContext.Provider>
  );
}
