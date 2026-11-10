import type { SpaceAgentModel } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { putSpaceAgentModel } from "../../shared/api/client.js";
import { spaceAgentModelQueryOptions } from "./space-agent-model-queries.js";

/** Saves the model new Spaces run on; `null` returns them to Auto. */
export const spaceAgentModelMutationOptions = (
  queryClient: QueryClient,
  identity: string,
) => ({
  mutationFn: (pin: typeof SpaceAgentModel.Encoded | null) =>
    putSpaceAgentModel(pin),
  onSuccess: (data: Awaited<ReturnType<typeof putSpaceAgentModel>>) => {
    queryClient.setQueryData(
      spaceAgentModelQueryOptions(identity).queryKey,
      data,
    );
  },
});
