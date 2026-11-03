import type { ProjectData } from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import {
  bitbucketConnectionQueryOptions,
  bitbucketRepositoriesQueryOptions,
} from "../settings/integrations/bitbucket-queries.js";
import { settingsContextQueryOptions } from "../settings/settings-context-queries.js";
import {
  NewProjectDialog,
  type NewProjectInput,
  type ProjectOwner,
} from "./new-project-dialog.js";
import { createProjectMutationOptions } from "./project-mutations.js";
import { sourceGrantsQueryOptions } from "./source-grant-queries.js";

/**
 * The New Project dialog with what it needs: the person's repositories, their
 * workspace, and the create request. A failed create keeps the dialog open
 * with the error; a created project closes it and reaches `onCreated`.
 */
export function NewProject({
  open,
  initialOwner,
  onOpenChange,
  onCreated,
}: {
  readonly open: boolean;
  /** Defaults to the workspace when the person has one. */
  readonly initialOwner?: ProjectOwner;
  readonly onOpenChange: (open: boolean) => void;
  readonly onCreated: (project: ProjectData) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const settingsQuery = useQuery(settingsContextQueryOptions(identity.id));
  const createProjectMutation = useMutation(
    createProjectMutationOptions(queryClient, identity.id),
  );
  const personalSourceGrantsQuery = useQuery(
    sourceGrantsQueryOptions(identity.id),
  );
  const bitbucketConnectionQuery = useQuery(
    bitbucketConnectionQueryOptions(identity.id),
  );
  const bitbucketConnection =
    bitbucketConnectionQuery.data?.connection?.status === "active"
      ? bitbucketConnectionQuery.data.connection
      : undefined;
  const bitbucketRepositoriesQuery = useQuery(
    bitbucketRepositoriesQueryOptions(identity.id, bitbucketConnection?.id),
  );
  const [actionError, setActionError] = React.useState<string>();
  const workspace = settingsQuery.data?.workspace;
  const owner =
    initialOwner ?? (workspace === undefined ? "personal" : "workspace");

  // Cleared on close as well as open: the composer opens the dialog without
  // its trigger, so this sees only the close.
  const changeOpen = (next: boolean) => {
    setActionError(undefined);
    createProjectMutation.reset();
    onOpenChange(next);
  };

  const submitProject = async (input: NewProjectInput) => {
    if (input.owner === "workspace" && workspace === undefined) {
      setActionError("Workspace settings are unavailable.");
      return;
    }
    setActionError(undefined);
    try {
      const project = await createProjectMutation.mutateAsync({
        name: input.name,
        description: input.description,
        source: input.source,
        ...(input.additionalRepositories === undefined
          ? {}
          : { additionalRepositories: input.additionalRepositories }),
        ...(input.owner === "workspace" && workspace !== undefined
          ? { workspaceSlug: workspace.shortName }
          : {}),
      });
      changeOpen(false);
      onCreated(project);
    } catch (cause) {
      if (!(cause instanceof Error))
        setActionError("Project could not be created.");
    }
  };

  return (
    <NewProjectDialog
      key={`${owner}:${workspace?.id ?? "personal"}`}
      actionError={
        actionError ??
        (createProjectMutation.error instanceof Error
          ? createProjectMutation.error.message
          : undefined)
      }
      creating={createProjectMutation.isPending}
      open={open}
      initialOwner={owner}
      grants={personalSourceGrantsQuery.data ?? []}
      bitbucketConnectionId={bitbucketConnection?.id}
      bitbucketRepositories={
        bitbucketConnection !== undefined &&
        bitbucketRepositoriesQuery.data?.connectionId ===
          bitbucketConnection?.id
          ? bitbucketRepositoriesQuery.data.repositories
          : []
      }
      grantsError={
        [
          personalSourceGrantsQuery.isError
            ? "GitHub repositories could not be loaded."
            : undefined,
          bitbucketConnectionQuery.isError || bitbucketRepositoriesQuery.isError
            ? "Bitbucket repositories could not be loaded."
            : undefined,
        ]
          .filter(Boolean)
          .join(" ") || undefined
      }
      repositoriesLoading={
        [
          personalSourceGrantsQuery.isPending ? "GitHub" : undefined,
          bitbucketConnectionQuery.isPending ||
          (bitbucketConnection !== undefined &&
            bitbucketRepositoriesQuery.isPending)
            ? "Bitbucket"
            : undefined,
        ]
          .filter(Boolean)
          .map((provider) => `Loading ${provider} repositories…`)
          .join(" ") || undefined
      }
      personalName={identity.name}
      workspace={workspace}
      onReloadIntegrations={() => {
        void personalSourceGrantsQuery.refetch();
        void bitbucketConnectionQuery.refetch();
        if (bitbucketConnection !== undefined)
          void bitbucketRepositoriesQuery.refetch();
      }}
      onOpenChange={changeOpen}
      onCreate={(input) => void submitProject(input)}
    />
  );
}
