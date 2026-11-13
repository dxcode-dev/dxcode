import type { ThreadData } from "@dx/api";
import { THREAD_TITLE_MAX_LENGTH } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "@tanstack/react-router";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { Button } from "../../shared/ui/button.js";
import { DialogRoot } from "../../shared/ui/dialog.js";
import { Input } from "../../shared/ui/input.js";
import { LazyConfirmDialog } from "../../shared/ui/lazy-confirm-dialog.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import {
  deleteThreadMutationOptions,
  updateThreadMutationOptions,
} from "./thread-mutations.js";

type RenameTarget = Pick<ThreadData, "id" | "title">;
/** `children`: how many listed child Threads go with it. */
type DeleteTarget = RenameTarget & { readonly children: number };

// Rename and Delete, loaded the first time one opens, so they stay out of
// the Thread page's first load. ThreadEditingProvider renders them.
export function RenameThreadDialog({
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
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface
        className="rename-thread-dialog"
        ariaLabel="Rename thread"
        initialFocus={input}
      >
        <ModalSurfaceHeader>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form onSubmit={submit}>
          <Input
            variant="bare"
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
    </DialogRoot>
  );
}

export function DeleteThreadDialog({
  thread,
  onClose,
}: {
  readonly thread: DeleteTarget;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const router = useRouter();
  // Owned by this dialog, as Rename's is.
  const remove = useMutation(
    deleteThreadMutationOptions(queryClient, identity.id),
  );
  const family = thread.children > 0;
  const confirm = () =>
    remove.mutate(
      family
        ? { threadId: thread.id, includeChildren: true }
        : { threadId: thread.id },
      {
        onSuccess: ({ deletedChildThreadIds = [] }) => {
          onClose();
          // The open Thread is gone; leave its page.
          if (
            [thread.id, ...deletedChildThreadIds].some(
              (id) =>
                router.state.location.pathname ===
                `/threads/${encodeURIComponent(id)}`,
            )
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
        : family
          ? "The threads could not be deleted."
          : "The thread could not be deleted.";
  return (
    <LazyConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={
        family ? `Delete ${thread.children + 1} Threads?` : "Delete Thread?"
      }
      description={
        <>
          <span className="delete-thread-dialog-name">
            &ldquo;{thread.title}&rdquo;
          </span>{" "}
          {family
            ? `and its ${thread.children} ${thread.children === 1 ? "subthread" : "subthreads"} will be permanently deleted, with their conversation histories and sandboxes.`
            : "will be permanently deleted, with its conversation history and sandbox."}
        </>
      }
      error={error}
      confirmLabel={remove.isPending ? "Deleting…" : "Delete"}
      destructive
      pending={remove.isPending}
      onConfirm={confirm}
    />
  );
}
