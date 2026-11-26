import { GetSpaceAgentModelEndpoint } from "@dx/api";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";

/** Settings → Models → Space: the model new Spaces run on, and its route. */
const getSpaceAgentModel = async (signal?: AbortSignal) =>
  (await dxClient.call(GetSpaceAgentModelEndpoint, {}, { signal })).data;

/** Models → Space: the model new Spaces run on, and where they'd run. */
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
