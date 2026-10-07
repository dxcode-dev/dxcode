import "../members/members.css";
import type { WorkspaceSlug } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { SettingsCard } from "../settings-primitives.js";
import { leaveWorkspaceMutationOptions } from "./workspace-mutations.js";

export function LeaveWorkspaceCard({
  workspaceSlug,
  displayName,
}: {
  readonly workspaceSlug: WorkspaceSlug;
  readonly displayName: string;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = React.useState(false);
  const leave = useMutation({
    ...leaveWorkspaceMutationOptions(workspaceSlug),
    onSuccess: async () => {
      await navigate({ to: "/", replace: true, ignoreBlocker: true });
      // Projects, Threads, and settings all change with membership.
      await queryClient.invalidateQueries();
    },
  });
  return (
    <SettingsCard
      title="Leave workspace"
      description="Remove yourself from this workspace. Your workspace threads stay with it and come back if you rejoin."
      actions={
        <Button size="xs" variant="outline" onClick={() => setOpen(true)}>
          Leave workspace
        </Button>
      }
    >
      <DialogRoot
        open={open}
        onOpenChange={(next) => {
          if (!leave.isPending) setOpen(next);
        }}
      >
        <DialogContent className="members-dialog">
          <DialogTitle>Leave {displayName}?</DialogTitle>
          <DialogDescription>
            You lose access to its projects, settings, and the threads you
            started in it until an admin invites you again.
          </DialogDescription>
          {leave.isError ? (
            <p className="members-error" role="alert">
              {leave.error instanceof Error
                ? leave.error.message
                : "Could not leave the workspace."}
            </p>
          ) : null}
          <footer className="members-dialog-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={leave.isPending}
              onClick={() => setOpen(false)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={leave.isPending}
              onClick={() => leave.mutate()}
            >
              {leave.isPending ? "Leaving…" : "Leave"}
            </Button>
          </footer>
        </DialogContent>
      </DialogRoot>
    </SettingsCard>
  );
}
