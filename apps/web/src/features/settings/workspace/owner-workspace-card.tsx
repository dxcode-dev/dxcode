import { Dialog } from "@base-ui/react/dialog";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { Input } from "../../../shared/ui/input.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../../shared/ui/modal-surface.js";
import { SettingsCard, SettingsRow } from "../settings-primitives.js";
import { deleteWorkspaceMutationOptions } from "./workspace-mutations.js";

/**
 * The owner's way out of a workspace: hand it to another member in Members
 * and then leave, or delete it.
 */
export function OwnerWorkspaceCard({
  workspaceSlug,
  displayName,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly displayName: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <SettingsCard>
      <SettingsRow
        title="Leave Workspace"
        description="Transfer ownership to another member first."
        control={
          <Link
            className={buttonVariants({ size: "xs", variant: "outline" })}
            to="/workspaces/$workspaceSlug/$section"
            params={{ workspaceSlug, section: "members" }}
          >
            Open Members
          </Link>
        }
      />
      <SettingsRow
        title="Delete Workspace"
        description="Permanently delete this workspace and all its data."
        control={
          <Button size="xs" variant="destructive" onClick={() => setOpen(true)}>
            Delete Workspace
          </Button>
        }
      />
      {open ? (
        <DeleteWorkspaceDialog
          workspaceSlug={workspaceSlug}
          displayName={displayName}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </SettingsCard>
  );
}

function DeleteWorkspaceDialog({
  workspaceSlug,
  displayName,
  onClose,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly displayName: string;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(deleteWorkspaceMutationOptions(workspaceSlug));
  const [threads, setThreads] = React.useState<"keep" | "delete">("keep");
  const [confirmation, setConfirmation] = React.useState("");
  const formId = React.useId();
  const confirmInput = React.useRef<HTMLInputElement>(null);
  const confirmed =
    confirmation.trim().toLowerCase() === workspaceSlug.toLowerCase();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!confirmed || remove.isPending) return;
    remove.mutate(
      { confirmShortName: confirmation, threads },
      {
        onSuccess: async () => {
          await navigate({ to: "/", replace: true, ignoreBlocker: true });
          // Projects, Threads, and settings all change with the workspace.
          await queryClient.invalidateQueries();
        },
      },
    );
  };
  return (
    <Dialog.Root
      open
      onOpenChange={(next) =>
        next || remove.isPending ? undefined : onClose()
      }
    >
      <ModalSurface
        className="delete-scope-dialog"
        ariaLabel="Delete workspace"
        initialFocus={confirmInput}
      >
        <ModalSurfaceHeader>
          <Dialog.Title className="delete-scope-dialog-title">
            Delete {displayName}?
          </Dialog.Title>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form className="delete-scope-dialog-body" onSubmit={submit}>
          <Dialog.Description>
            Its projects, settings, secrets, connections, and invite links are
            deleted, and every member loses access. This cannot be undone.
          </Dialog.Description>
          <fieldset className="delete-scope-choices">
            <legend>Threads in its projects</legend>
            <label>
              <input
                type="radio"
                name={`${formId}-threads`}
                checked={threads === "keep"}
                onChange={() => setThreads("keep")}
              />
              <span>
                Keep them archived. Each person keeps the threads they started,
                read-only, and they can never be unarchived.
              </span>
            </label>
            <label>
              <input
                type="radio"
                name={`${formId}-threads`}
                checked={threads === "delete"}
                onChange={() => setThreads("delete")}
              />
              <span>Delete them, with their conversations and sandboxes.</span>
            </label>
          </fieldset>
          <label className="delete-scope-confirm" htmlFor={`${formId}-name`}>
            Type <strong>{workspaceSlug}</strong> to confirm
          </label>
          <Input
            ref={confirmInput}
            id={`${formId}-name`}
            autoComplete="off"
            spellCheck={false}
            value={confirmation}
            disabled={remove.isPending}
            onChange={(event) => setConfirmation(event.target.value)}
          />
          {remove.isError ? (
            <div className="notice error-notice" role="alert">
              {remove.error instanceof Error && remove.error.message !== ""
                ? remove.error.message
                : "The workspace could not be deleted."}
            </div>
          ) : null}
          <footer>
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={remove.isPending}
              onClick={onClose}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              size="xs"
              variant="destructive"
              disabled={!confirmed || remove.isPending}
            >
              {remove.isPending ? (
                <LoaderCircle className="spin" aria-hidden="true" />
              ) : (
                <Trash2 aria-hidden="true" />
              )}
              {remove.isPending ? "Deleting…" : "Delete Workspace"}
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </Dialog.Root>
  );
}
