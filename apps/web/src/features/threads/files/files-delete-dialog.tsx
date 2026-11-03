import { Dialog } from "@base-ui/react/dialog";
import type { ThreadFilesPath, ThreadFilesWorktreeId } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../../shared/ui/modal-surface.js";
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
  const cancel = React.useRef<HTMLButtonElement>(null);
  const folder = target.kind === "directory";
  const confirm = () =>
    remove.mutate(
      { action: "delete", path: target.path },
      { onSuccess: onClose },
    );
  const error =
    remove.error === null ? undefined : writeErrorMessage(remove.error);
  return (
    <Dialog.Root
      open
      onOpenChange={(open) =>
        open || remove.isPending ? undefined : onClose()
      }
    >
      <ModalSurface
        className="delete-thread-dialog"
        ariaLabel={folder ? "Delete folder" : "Delete file"}
        initialFocus={cancel}
      >
        <ModalSurfaceHeader>
          <Dialog.Title className="delete-thread-dialog-title">
            {folder ? "Delete Folder?" : "Delete File?"}
          </Dialog.Title>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <div className="delete-thread-dialog-body">
          <Dialog.Description>
            <span className="delete-thread-dialog-name">
              &ldquo;{baseName(target.path)}&rdquo;
            </span>{" "}
            {folder
              ? "and everything in it will be deleted from the workspace."
              : "will be deleted from the workspace."}
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
