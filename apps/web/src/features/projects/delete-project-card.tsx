import { Dialog } from "@base-ui/react/dialog";
import type { ProjectData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { LoaderCircle, Trash2 } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Input } from "../../shared/ui/input.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../shared/ui/modal-surface.js";
import { SettingsCard, SettingsRow } from "../../shared/ui/settings.js";
import {
  deleteProjectMutationOptions,
  forgetDeletedProject,
} from "./project-mutations.js";

/** The last row of General: delete the project, after choosing its Threads' fate. */
export function DeleteProjectCard({
  project,
  userId,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <SettingsCard>
      <SettingsRow
        title="Delete Project"
        description="Permanently delete this project and choose what happens to its threads."
        control={
          <Button size="xs" variant="destructive" onClick={() => setOpen(true)}>
            Delete Project
          </Button>
        }
      />
      {open ? (
        <DeleteProjectDialog
          project={project}
          userId={userId}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </SettingsCard>
  );
}

function DeleteProjectDialog({
  project,
  userId,
  onClose,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
  readonly onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const remove = useMutation(
    deleteProjectMutationOptions(queryClient, userId, project.id),
  );
  const [threads, setThreads] = React.useState<"keep" | "delete">("keep");
  const [confirmation, setConfirmation] = React.useState("");
  const formId = React.useId();
  const confirmInput = React.useRef<HTMLInputElement>(null);
  const confirmed =
    confirmation.trim().toLowerCase() === project.name.trim().toLowerCase();
  const submit = (event: React.FormEvent) => {
    event.preventDefault();
    if (!confirmed || remove.isPending) return;
    remove.mutate(
      { confirmName: confirmation, threads },
      {
        onSuccess: async () => {
          await navigate({
            to: "/projects",
            replace: true,
            ignoreBlocker: true,
          });
          forgetDeletedProject(queryClient, userId, project.id);
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
        ariaLabel="Delete project"
        initialFocus={confirmInput}
      >
        <ModalSurfaceHeader>
          <Dialog.Title className="delete-scope-dialog-title">
            Delete {project.name}?
          </Dialog.Title>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        <form className="delete-scope-dialog-body" onSubmit={submit}>
          <Dialog.Description>
            Its settings, secrets, and environment variables are deleted, and it
            leaves every project list. This cannot be undone.
          </Dialog.Description>
          <fieldset className="delete-scope-choices">
            <legend>Threads in this project</legend>
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
            Type <strong>{project.name}</strong> to confirm
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
                : "The project could not be deleted."}
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
              {remove.isPending ? "Deleting…" : "Delete Project"}
            </Button>
          </footer>
        </form>
      </ModalSurface>
    </Dialog.Root>
  );
}
