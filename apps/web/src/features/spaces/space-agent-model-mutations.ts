import type { UpdateSpaceAgentModelRequestSchema } from "@dx/api";
import { UpdateSpaceAgentModelEndpoint } from "@dx/api";
import type { SpaceAgentModel } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { spaceAgentModelQueryOptions } from "./space-agent-model-queries.js";

/** `null` returns new Spaces to Auto (Claude Opus 5.5, medium). */
const putSpaceAgentModel = async (
  pin: (typeof UpdateSpaceAgentModelRequestSchema.Encoded)["pin"],
) =>
  (
    await dxClient.call(UpdateSpaceAgentModelEndpoint, {
      // The model id the person picked; Core refuses one it does not serve.
      body: {
        pin: pin as (typeof UpdateSpaceAgentModelRequestSchema.Type)["pin"],
      },
    })
  ).data;

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
