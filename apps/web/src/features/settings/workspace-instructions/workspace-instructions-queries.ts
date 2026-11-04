import type { WorkspaceSlug } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import {
  getWorkspaceAgentInstructions,
  updateWorkspaceAgentInstructions,
} from "../../../shared/api/client.js";

const workspaceInstructionsKey = (workspaceSlug: WorkspaceSlug) =>
  ["workspace-settings", workspaceSlug, "agent-instructions"] as const;

export const workspaceAgentInstructionsQueryOptions = (
  workspaceSlug: WorkspaceSlug,
) =>
  queryOptions({
    queryKey: workspaceInstructionsKey(workspaceSlug),
    queryFn: ({ signal }) =>
      getWorkspaceAgentInstructions(workspaceSlug, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const updateWorkspaceAgentInstructionsMutationOptions = (
  queryClient: QueryClient,
  workspaceSlug: WorkspaceSlug,
) =>
  mutationOptions({
    mutationKey: [...workspaceInstructionsKey(workspaceSlug), "update"],
    mutationFn: (input: {
      readonly instructions: string;
      readonly expectedRevision: number;
    }) => updateWorkspaceAgentInstructions(workspaceSlug, input),
    onSuccess: async (instructions) => {
      const queryKey = workspaceInstructionsKey(workspaceSlug);
      await queryClient.cancelQueries({ queryKey, exact: true });
      queryClient.setQueryData(queryKey, instructions);
    },
  });
