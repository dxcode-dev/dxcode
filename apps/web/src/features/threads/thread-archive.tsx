import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Archive, ArchiveRestore } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadArchiveContext,
  type ThreadArchiveController,
} from "../../shared/thread-archive.js";
import {
  setThreadArchivedMutationOptions,
  setThreadsArchivedMutationOptions,
} from "./thread-mutations.js";
import { threadSeenWorking } from "./thread-queries.js";

/** "Stop and archive?", loaded the first time a working Thread is archived. */
const ConfirmDialog = React.lazy(() =>
  import("../../shared/ui/confirm-dialog.js").then((module) => ({
    default: module.ConfirmDialog,
  })),
);

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
  const { isPending, mutateAsync, variables } = mutation;
  const bulk = useMutation(
    setThreadsArchivedMutationOptions(queryClient, identity.id),
  );
  const archiveManyAsync = bulk.mutateAsync;
  /** An archive that waits for the person to confirm stopping work. */
  const [confirming, setConfirming] = React.useState<
    { readonly working: number; readonly archive: () => void } | undefined
  >();
  /** Asks first when any of these Threads is working; otherwise archives. */
  const archiveAfterAsking = (
    threadIds: ReadonlyArray<ThreadId>,
    archive: () => void,
  ) => {
    const working = threadIds.filter((threadId) =>
      threadSeenWorking(queryClient, identity.id, threadId),
    ).length;
    if (working === 0) archive();
    else setConfirming({ working, archive });
  };

  /**
   * The Thread changes on the page at once, so the notice shows at once too;
   * requests run in order, so Undo works before the archive is saved.
   * `children`: true for every child in the parent's former state, or the
   * children an Undo restores, once its archive answers.
   */
  const changeArchived = (
    threadId: ThreadId,
    archived: boolean,
    children?: true | Promise<ReadonlyArray<ThreadId> | undefined>,
  ) => {
    const includeChildren = children !== undefined;
    let undone = false;
    const request = mutateAsync(
      children === undefined
        ? { threadId, archived }
        : { threadId, archived, children },
    );
    // Every call names each option, because a toast updated in place
    // keeps any option the new one leaves out.
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
                // Undo's result replaces this toast.
                event.preventDefault();
                undone = true;
                changeArchived(
                  threadId,
                  false,
                  includeChildren
                    ? request.then(
                        ({ changedChildThreadIds }) =>
                          changedChildThreadIds?.length
                            ? changedChildThreadIds
                            : undefined,
                        () => undefined,
                      )
                    : undefined,
                );
              },
            }
          : undefined,
      },
    );
    request.catch((cause: unknown) => {
      // An Undo already put the Thread back; its own result reports.
      if (undone) return;
      toast.error(
        cause instanceof Error && cause.message
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
      );
    });
  };

  const setArchived = (
    threadId: ThreadId,
    archived: boolean,
    includeChildren = false,
  ) => {
    const change = () =>
      changeArchived(threadId, archived, includeChildren ? true : undefined);
    if (archived) archiveAfterAsking([threadId], change);
    else change();
  };

  /** Archives many at once, or with `archived` false restores them. */
  const changeManyArchived = (
    threadIds: ReadonlyArray<ThreadId>,
    archived: boolean,
  ) => {
    if (threadIds.length === 0) return;
    let undone = false;
    const request = archiveManyAsync({ threadIds, archived });
    const count = (n: number) => `${n} ${n === 1 ? "thread" : "threads"}`;
    toast(
      archived
        ? `Archived ${count(threadIds.length)}`
        : `Unarchived ${count(threadIds.length)}`,
      {
        id: ARCHIVE_TOAST_ID,
        duration: ARCHIVE_TOAST_DURATION,
        icon: archived ? <Archive /> : <ArchiveRestore />,
        action: archived
          ? {
              label: "Undo",
              onClick: (event) => {
                event.preventDefault();
                undone = true;
                // Undo restores the ones this archive changed, once it ends;
                // until then they all show as restored.
                void request.then(
                  ({ changed }) => changeManyArchived(changed, false),
                  () => changeManyArchived(threadIds, false),
                );
              },
            }
          : undefined,
      },
    );
    void request.then(
      ({ failed }) => {
        if (undone || failed.length === 0) return;
        toast.error(
          `${count(failed.length)} could not be ${archived ? "archived" : "unarchived"}.`,
          {
            id: ARCHIVE_TOAST_ID,
            duration: ARCHIVE_TOAST_DURATION,
            icon: undefined,
            action: undefined,
          },
        );
      },
      () => undefined,
    );
  };

  const controller: ThreadArchiveController = {
    setArchived,
    archiveMany: (threadIds) =>
      archiveAfterAsking(threadIds, () => changeManyArchived(threadIds, true)),
    pendingThreadId: isPending ? variables.threadId : undefined,
    pendingArchived: isPending ? variables.archived : undefined,
  };

  return (
    <ThreadArchiveContext.Provider value={controller}>
      {children}
      {confirming === undefined ? null : (
        <React.Suspense fallback={null}>
          <ConfirmDialog
            open
            onOpenChange={(open) => {
              if (!open) setConfirming(undefined);
            }}
            title="Stop and archive?"
            description={
              confirming.working > 1
                ? `${confirming.working} of these threads are still working. Archiving stops their turns and any queued messages.`
                : "This thread is still working. Archiving stops its turn and any queued messages."
            }
            confirmLabel="Stop and archive"
            destructive
            onConfirm={() => {
              confirming.archive();
              setConfirming(undefined);
            }}
          />
        </React.Suspense>
      )}
    </ThreadArchiveContext.Provider>
  );
}
