import type { SpaceData } from "@dx/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { deleteThreadMutationOptions } from "../threads/thread-mutations.js";
import { spaceKeys } from "./space-cache-queries.js";

/**
 * Deletes the Space after asking. `onDeleted` runs once it is gone, such as
 * its page going home; the sidebar stops listing it at once.
 */
export function DeleteSpaceDialog({
  space,
  onClose,
  onDeleted,
}: {
  readonly space: SpaceData;
  readonly onClose: () => void;
  readonly onDeleted?: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const remove = useMutation(
    deleteThreadMutationOptions(queryClient, identity.id),
  );
  return (
    <ConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title="Delete Space?"
      description={
        <>
          &ldquo;{space.name}&rdquo; and its chat will be permanently deleted.
          The threads it started stay in your sidebar.
        </>
      }
      error={
        remove.error === null
          ? undefined
          : remove.error instanceof Error && remove.error.message !== ""
            ? remove.error.message
            : "The Space could not be deleted."
      }
      confirmLabel={remove.isPending ? "Deleting…" : "Delete"}
      destructive
      pending={remove.isPending}
      onConfirm={() =>
        remove.mutate(
          { threadId: space.threadId },
          {
            onSuccess: () => {
              queryClient.setQueryData<ReadonlyArray<SpaceData>>(
                spaceKeys.joined(identity.id),
                (spaces) =>
                  spaces?.filter(({ threadId }) => threadId !== space.threadId),
              );
              onClose();
              onDeleted?.();
            },
          },
        )
      }
    />
  );
}
