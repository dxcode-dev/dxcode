import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import type { ArchivedThread } from "../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadArchiveContext,
  type ThreadArchiveController,
} from "../../shared/thread-archive.js";
import { setThreadArchivedMutationOptions } from "./thread-mutations.js";

/** One toast at a time: each notice replaces the one before it. */
const ARCHIVE_TOAST_ID = "thread-archive";
/** How long a result stays before it goes away. */
const ARCHIVE_TOAST_DURATION = 6_000;

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
  const mutationPending = React.useRef(false);

  /**
   * `children`: true for every child in the parent's former state, or the
   * exact children an Undo restores.
   */
  const changeArchived = (
    threadId: ThreadId,
    archived: boolean,
    children?: true | ReadonlyArray<ThreadId>,
  ) => {
    const includeChildren = children !== undefined;
    if (mutationPending.current) return;
    mutationPending.current = true;
    // Every call names each option, because a toast updated in place
    // keeps any option the new one leaves out.
    toast.loading(
      archived
        ? includeChildren
          ? "Archiving threads…"
          : "Archiving thread…"
        : "Unarchiving thread…",
      { id: ARCHIVE_TOAST_ID, icon: undefined, action: undefined },
    );
    mutate(
      children === undefined
        ? { threadId, archived }
        : { threadId, archived, children },
      {
        onSuccess: ({ thread, changedChildThreadIds }: ArchivedThread) =>
          toast(
            archived
              ? includeChildren
                ? "Archived threads"
                : "Archived thread"
              : "Unarchived thread",
            {
              id: ARCHIVE_TOAST_ID,
              duration: ARCHIVE_TOAST_DURATION,
              icon: archived ? <Archive /> : <ArchiveRestore />,
              action: archived
                ? {
                    label: "Undo",
                    onClick: (event) => {
                      // Undo's progress and result replace this toast.
                      event.preventDefault();
                      changeArchived(
                        thread.id,
                        false,
                        changedChildThreadIds === undefined ||
                          changedChildThreadIds.length === 0
                          ? undefined
                          : changedChildThreadIds,
                      );
                    },
                  }
                : undefined,
            },
          ),
        onError: (cause) =>
          toast.error(
            cause instanceof Error
              ? cause.message
              : archived
                ? "Thread could not be archived."
                : "Thread could not be unarchived.",
            {
              id: ARCHIVE_TOAST_ID,
              duration: ARCHIVE_TOAST_DURATION,
              icon: undefined,
              action: undefined,
            },
          ),
        onSettled: () => {
          mutationPending.current = false;
        },
      },
    );
  };

  const setArchived = (
    threadId: ThreadId,
    archived: boolean,
    includeChildren = false,
  ) => changeArchived(threadId, archived, includeChildren ? true : undefined);

  const controller: ThreadArchiveController = {
    setArchived,
    pendingThreadId: isPending ? variables.threadId : undefined,
    pendingArchived: isPending ? variables.archived : undefined,
  };

  return (
    <ThreadArchiveContext.Provider value={controller}>
      {children}
    </ThreadArchiveContext.Provider>
  );
}
