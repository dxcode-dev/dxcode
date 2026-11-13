import type { ProjectData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { Radio } from "../../shared/ui/checkbox.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { Input } from "../../shared/ui/input.js";
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
  const submit = (event?: React.FormEvent) => {
    event?.preventDefault();
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
    <ConfirmDialog
      open
      onOpenChange={(next) => (next ? undefined : onClose())}
      title={`Delete ${project.name}?`}
      description="Its settings, secrets, and environment variables are deleted, and it leaves every project list. This cannot be undone."
      error={
        remove.isError
          ? remove.error instanceof Error && remove.error.message !== ""
            ? remove.error.message
            : "The project could not be deleted."
          : undefined
      }
      confirmLabel={remove.isPending ? "Deleting…" : "Delete Project"}
      destructive
      pending={remove.isPending}
      confirmDisabled={!confirmed}
      initialFocus={confirmInput}
      onConfirm={() => submit()}
    >
      {/* A form, so Enter in the name field confirms. */}
      <form className="delete-scope-form" onSubmit={submit}>
        <fieldset className="delete-scope-choices">
          <legend>Threads in this project</legend>
          <label htmlFor={`${formId}-keep`}>
            <Radio
              id={`${formId}-keep`}
              name={`${formId}-threads`}
              checked={threads === "keep"}
              onChange={() => setThreads("keep")}
            />
            <span>
              Keep them archived. Each person keeps the threads they started,
              read-only, and they can never be unarchived.
            </span>
          </label>
          <label htmlFor={`${formId}-delete`}>
            <Radio
              id={`${formId}-delete`}
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
      </form>
    </ConfirmDialog>
  );
}
