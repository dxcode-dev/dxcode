import type { ThreadData } from "@dx/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadEditingContext,
  type ThreadEditingController,
} from "../../shared/thread-editing.js";
import {
  setThreadPinnedMutationOptions,
  updateThreadMutationOptions,
} from "./thread-mutations.js";
import { listedChildCount, threadsQueryOptions } from "./thread-queries.js";

const RenameThreadDialog = React.lazy(() =>
  import("./thread-editing-dialogs.js").then((module) => ({
    default: module.RenameThreadDialog,
  })),
);
const DeleteThreadDialog = React.lazy(() =>
  import("./thread-editing-dialogs.js").then((module) => ({
    default: module.DeleteThreadDialog,
  })),
);

type RenameTarget = Pick<ThreadData, "id" | "title">;
/** `children`: how many listed child Threads go with it. */
type DeleteTarget = RenameTarget & { readonly children: number };

export function ThreadEditingProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const { mutate } = useMutation(
    updateThreadMutationOptions(queryClient, identity.id),
  );
  const pin = useMutation(
    setThreadPinnedMutationOptions(queryClient, identity.id),
  );
  const [renaming, setRenaming] = React.useState<RenameTarget>();
  const [deleting, setDeleting] = React.useState<DeleteTarget>();

  const controller: ThreadEditingController = {
    openRename: (thread) => setRenaming({ id: thread.id, title: thread.title }),
    openDelete: (thread, children = 0) =>
      setDeleting({ id: thread.id, title: thread.title, children }),
    setColor: (threadId, color) => mutate({ threadId, update: { color } }),
    childCount: (threadId) =>
      listedChildCount(queryClient, identity.id, threadId),
    // A Thread's detail has no pin; the sidebar's list does.
    pinned: (threadId) =>
      queryClient
        .getQueryData(
          threadsQueryOptions(identity.id, undefined, "active", "roots")
            .queryKey,
        )
        ?.pages.some((page) =>
          page.items.some(
            (item) => item.id === threadId && item.pinnedAt !== undefined,
          ),
        ) === true,
    setPinned: (threadId, pinned) =>
      pin.mutate(
        { threadId, pinned },
        {
          onError: () =>
            toast.error(
              pinned
                ? "The thread could not be pinned."
                : "The thread could not be unpinned.",
            ),
        },
      ),
    pinningThreadId: pin.isPending ? pin.variables.threadId : undefined,
  };

  return (
    <ThreadEditingContext.Provider value={controller}>
      {children}
      {renaming === undefined ? null : (
        <React.Suspense fallback={null}>
          <RenameThreadDialog
            key={renaming.id}
            thread={renaming}
            onClose={() => setRenaming(undefined)}
          />
        </React.Suspense>
      )}
      {deleting === undefined ? null : (
        <React.Suspense fallback={null}>
          <DeleteThreadDialog
            key={deleting.id}
            thread={deleting}
            onClose={() => setDeleting(undefined)}
          />
        </React.Suspense>
      )}
    </ThreadEditingContext.Provider>
  );
}
