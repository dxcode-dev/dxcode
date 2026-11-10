import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { getSpaceAgentModel } from "../../shared/api/client.js";

/** Mode Dial → Space: the model new Spaces run on, and where they'd run. */
export const spaceAgentModelQueryOptions = (identity: string) =>
  queryOptions({
    queryKey: ["space-agent-model", identity] as const,
    queryFn: ({ signal }) => getSpaceAgentModel(signal),
  });

/** Reads the route again, as after the server refused a new Space. */
export const refreshSpaceAgentModel = (
  queryClient: QueryClient,
  identity: string,
) =>
  queryClient.invalidateQueries({
    queryKey: spaceAgentModelQueryOptions(identity).queryKey,
  });
