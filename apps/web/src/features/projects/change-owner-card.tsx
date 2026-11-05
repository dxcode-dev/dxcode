import type { ProjectData, SettingsContextData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { SettingsCard, SettingsRow } from "../../shared/ui/settings.js";
import { moveProjectMutationOptions } from "./change-owner-mutations.js";

/**
 * Change Owner (#1198): moves a personal project into the person's
 * workspace, one way. Disabled for a workspace project, and when the person
 * has no workspace.
 */
export function ChangeOwnerCard({
  project,
  userId,
  workspace,
}: {
  readonly project: ProjectData;
  readonly userId: UserId;
  readonly workspace: SettingsContextData["workspace"];
}) {
  const queryClient = useQueryClient();
  const move = useMutation(
    moveProjectMutationOptions(queryClient, userId, project.id),
  );
  const [open, setOpen] = React.useState(false);
  const movable = project.workspaceId === undefined && workspace !== undefined;
  const confirm = () => {
    if (workspace === undefined || move.isPending) return;
    move.mutate(
      { workspaceSlug: workspace.shortName, revision: project.revision },
      { onSettled: () => setOpen(false) },
    );
  };
  return (
    <SettingsCard>
      <SettingsRow
        title="Change Owner"
        description="Projects can only be transferred from personal to a workspace."
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!movable || move.isPending}
            onClick={() => {
              move.reset();
              setOpen(true);
            }}
          >
            Change Owner
          </Button>
        }
      />
      {move.isError ? (
        <div className="notice error-notice" role="alert">
          {move.error instanceof Error && move.error.message !== ""
            ? move.error.message
            : "The project could not be moved."}
        </div>
      ) : null}
      {workspace === undefined ? null : (
        <ConfirmDialog
          open={open}
          onOpenChange={setOpen}
          title={`Move ${project.name} to ${workspace.displayName}?`}
          description="Members will see it and can start their own threads in it, with its secrets, environment variables, and Orb scripts. Your threads stay private unless you share them, and your personal secrets, connections, and Orb keys stay yours. Workspace policy applies from now on, so Orbs running on your personal keys may stop. This cannot be undone."
          confirmLabel={move.isPending ? "Moving…" : "Move Project"}
          pending={move.isPending}
          onConfirm={confirm}
        />
      )}
    </SettingsCard>
  );
}
