import { Dialog } from "@base-ui/react/dialog";
import type { ThreadData } from "@dx/api";
import { THREAD_TITLE_MAX_LENGTH } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import { LoaderCircle, Trash2 } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  ThreadEditingContext,
  type ThreadEditingController,
} from "../../shared/thread-editing.js";
import { Button } from "../../shared/ui/button.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import {
  deleteThreadMutationOptions,
  setThreadPinnedMutationOptions,
  updateThreadMutationOptions,
} from "./thread-mutations.js";
import { threadsQueryOptions } from "./thread-queries.js";

type RenameTarget = Pick<ThreadData, "id" | "title">;

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
  const { mutate: pin } = useMutation(
    setThreadPinnedMutationOptions(queryClient, identity.id),
  );
  const [renaming, setRenaming] = React.useState<RenameTarget>();
  const [deleting, setDeleting] = React.useState<RenameTarget>();

  const controller: ThreadEditingController = {
    openRename: (thread) => setRenaming({ id: thread.id, title: thread.title }),
    openDelete: (thread) => setDeleting({ id: thread.id, title: thread.title }),
    setColor: (threadId, color) => mutate({ threadId, update: { color } }),
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
    setPinned: (threadId, pinned) => pin({ threadId, pinned }),
  };

  return (
    <ThreadEditingContext.Provider value={controller}>
      {children}
      {renaming === undefined ? null : (
        <RenameThreadDialog
          key={renaming.id}
          thread={renaming}
          onClose={() => setRenaming(undefined)}
        />
      )}
      {deleting === undefined ? null : (
        <DeleteThreadDialog
          key={deleting.id}
          thread={deleting}
          onClose={() => setDeleting(undefined)}
        />
      )}
    </ThreadEditingContext.Provider>
  );
}

function RenameThreadDialog({
  thread,
  onClose,
}: {
  readonly thread: RenameTarget;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  // Owned by this dialog: a rename that settles after the dialog closed
  // cannot close or report into another dialog opened since.
  const rename = useMutation(
    updateThreadMutationOptions(queryClient, identity.id),
  );
  const [title, setTitle] = React.useState(thread.title);
  const input = React.useRef<HTMLInputElement>(null);
  const next = title.replace(/\s+/gu, " ").trim();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (next.length === 0 || next === thread.title) return onClose();
    rename.mutate(
      { threadId: thread.id, update: { title: next } },
      { onSuccess: onClose },
    );
  };
  const error =
    rename.error === null
      ? undefined
      : rename.error instanceof Error && rename.error.message !== ""
        ? rename.error.message
        : "The thread could not be renamed.";
  return (
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface
        className="rename-thread-dialog"
        ariaLabel="Rename thread"
        initialFocus={input}
      >
        <ModalSurfaceHeader>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form onSubmit={submit}>
          <input
            ref={input}
            aria-label="Thread title"
            value={title}
            maxLength={THREAD_TITLE_MAX_LENGTH}
            onFocus={(event) => event.currentTarget.select()}
            onChange={(event) => setTitle(event.currentTarget.value)}
          />
          {error === undefined ? null : (
            <div className="notice error-notice" role="alert">
              {error}
            </div>
          )}
          <footer>
            <Button
              type="submit"
              size="xs"
              disabled={rename.isPending || next.length === 0}
            >
              Rename
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </Dialog.Root>
  );
}

function DeleteThreadDialog({
  thread,
  onClose,
}: {
  readonly thread: RenameTarget;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const router = useRouter();
  // Owned by this dialog, as Rename's is.
  const remove = useMutation(
    deleteThreadMutationOptions(queryClient, identity.id),
  );
  const cancel = React.useRef<HTMLButtonElement>(null);
  const confirm = () =>
    remove.mutate(
      { threadId: thread.id },
      {
        onSuccess: () => {
          onClose();
          // The open Thread is gone; leave its page.
          if (
            router.state.location.pathname ===
            `/threads/${encodeURIComponent(thread.id)}`
          )
            void router.navigate({ to: "/" });
        },
      },
    );
  const error =
    remove.error === null
      ? undefined
      : remove.error instanceof Error && remove.error.message !== ""
        ? remove.error.message
        : "The thread could not be deleted.";
  return (
    <Dialog.Root
      open
      onOpenChange={(open) =>
        open || remove.isPending ? undefined : onClose()
      }
    >
      <ModalSurface
        className="delete-thread-dialog"
        ariaLabel="Delete thread"
        initialFocus={cancel}
      >
        <ModalSurfaceHeader>
          <Dialog.Title className="delete-thread-dialog-title">
            Delete Thread?
          </Dialog.Title>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <div className="delete-thread-dialog-body">
          <Dialog.Description>
            <span className="delete-thread-dialog-name">
              &ldquo;{thread.title}&rdquo;
            </span>{" "}
            will be permanently deleted, with its conversation history and
            sandbox.
          </Dialog.Description>
          {error === undefined ? null : (
            <div className="notice error-notice" role="alert">
              {error}
            </div>
          )}
          <Button
            type="button"
            variant="destructive"
            disabled={remove.isPending}
            onClick={confirm}
          >
            {remove.isPending ? (
              <LoaderCircle className="spin" aria-hidden="true" />
            ) : (
              <Trash2 aria-hidden="true" />
            )}
            {remove.isPending ? "Deleting…" : "Delete"}
          </Button>
          <Button
            ref={cancel}
            type="button"
            variant="outline"
            disabled={remove.isPending}
            onClick={onClose}
          >
            Cancel
          </Button>
        </div>
      </ModalSurface>
    </Dialog.Root>
  );
}
