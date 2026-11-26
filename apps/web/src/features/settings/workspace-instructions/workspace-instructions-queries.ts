import {
  GetWorkspaceAgentInstructionsEndpoint,
  UpdateWorkspaceAgentInstructionsEndpoint,
  type WorkspaceAgentInstructionsData,
} from "@dx/api";
import type { WorkspaceSlug } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

/** A workspace's AGENTS.md: members read it, admins change it. */
const getWorkspaceAgentInstructions = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
): Promise<WorkspaceAgentInstructionsData> =>
  (
    await dxClient.call(
      GetWorkspaceAgentInstructionsEndpoint,
      { params: { workspaceSlug } },
      { signal },
    )
  ).data;

const updateWorkspaceAgentInstructions = async (
  workspaceSlug: WorkspaceSlug,
  input: {
    readonly instructions: string;
    readonly expectedRevision: number;
  },
): Promise<WorkspaceAgentInstructionsData> =>
  (
    await dxClient.call(UpdateWorkspaceAgentInstructionsEndpoint, {
      params: { workspaceSlug },
      body: input,
    })
  ).data;

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
