import type { ThreadFilesPath, ThreadFilesWorktreeId } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LazyConfirmDialog } from "../../../shared/ui/lazy-confirm-dialog.js";
import type { ThreadFilesApi } from "./files-api.js";
import { writeThreadFilesOptions } from "./files-queries.js";
import { baseName, writeErrorMessage } from "./files-tree-names.js";

export interface FilesDeleteTarget {
  readonly path: ThreadFilesPath;
  readonly kind: "file" | "directory";
}

/** Deleting a file or folder from the Files tree, as Delete Thread asks. */
export function FilesDeleteDialog({
  api,
  threadId,
  worktree,
  target,
  onClose,
}: {
  readonly api: ThreadFilesApi;
  readonly threadId: ThreadId;
  readonly worktree: ThreadFilesWorktreeId;
  readonly target: FilesDeleteTarget;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  // Owned by this dialog, as Delete Thread's is.
  const remove = useMutation(
    writeThreadFilesOptions(api, threadId, worktree, queryClient),
  );
  const folder = target.kind === "directory";
  const confirm = () =>
    remove.mutate(
      { action: "delete", path: target.path },
      { onSuccess: onClose },
    );
  return (
    <LazyConfirmDialog
      open
      onOpenChange={(open) => (open ? undefined : onClose())}
      title={folder ? "Delete Folder?" : "Delete File?"}
      description={
        <>
          <span className="delete-thread-dialog-name">
            &ldquo;{baseName(target.path)}&rdquo;
          </span>{" "}
          {folder
            ? "and everything in it will be deleted from the workspace."
            : "will be deleted from the workspace."}
        </>
      }
      error={
        remove.error === null ? undefined : writeErrorMessage(remove.error)
      }
      confirmLabel={remove.isPending ? "Deleting…" : "Delete"}
      destructive
      pending={remove.isPending}
      onConfirm={confirm}
    />
  );
}
