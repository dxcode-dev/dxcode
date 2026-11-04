import { MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import { Button } from "../../../shared/ui/button.js";
import { AgentInstructionsForm } from "../advanced/personal-advanced-settings.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  updateWorkspaceAgentInstructionsMutationOptions,
  workspaceAgentInstructionsQueryOptions,
} from "./workspace-instructions-queries.js";

/** The workspace's AGENTS.md: admins edit it, members read it. */
export function WorkspaceInstructionsSettings({
  onDirtyChange,
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) return null;
  return (
    <WorkspaceInstructions
      onDirtyChange={onDirtyChange}
      workspaceSlug={workspaceSlug}
    />
  );
}

function WorkspaceInstructions({
  onDirtyChange,
  workspaceSlug,
}: SettingsSectionProps & {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
}) {
  const queryClient = useQueryClient();
  const instructions = useQuery(
    workspaceAgentInstructionsQueryOptions(workspaceSlug),
  );
  const update = useMutation(
    updateWorkspaceAgentInstructionsMutationOptions(queryClient, workspaceSlug),
  );

  if (instructions.isPending && instructions.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading instructions…</strong>
      </div>
    );
  }
  if (instructions.data === undefined) {
    return (
      <div className="settings-route-state" role="alert">
        <AlertTriangle />
        <strong>
          {instructions.error instanceof Error
            ? instructions.error.message
            : "Instructions could not be loaded."}
        </strong>
        <Button
          size="sm"
          variant="outline"
          onClick={() => void instructions.refetch()}
        >
          Try again
        </Button>
      </div>
    );
  }
  return (
    <AgentInstructionsForm
      initialSettings={instructions.data}
      onDirtyChange={onDirtyChange}
      onReload={async () => {
        const result = await instructions.refetch();
        return result.error === null ? result.data : undefined;
      }}
      updateInstructions={update.mutateAsync}
      saving={update.isPending}
      heading="Guidance every member's agent receives. Members add their own instructions, and each project adds its AGENTS.md."
      fileName="Workspace AGENTS.md"
      fileDescription="Guidance for workspace members' top-level agents in every Thread."
      maxLength={MAX_WORKSPACE_AGENT_INSTRUCTIONS_LENGTH}
      savedMessage="Saved. Members' agents use these from their next message."
      {...(instructions.data.canUpdate
        ? {}
        : { readOnlyNote: "Only workspace admins can change these." })}
    />
  );
}
