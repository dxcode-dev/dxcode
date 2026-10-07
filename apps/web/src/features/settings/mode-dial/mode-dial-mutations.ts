import type { PutModeRequestSchema } from "@dx/api";
import type { ModeId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  type ModelRoutingTarget,
  putProfileMode,
  putWorkspaceProfileMode,
  resetProfileMode,
  resetWorkspaceProfileMode,
} from "../../../shared/api/client.js";
import { modelRoutingKey } from "../model-routing/model-routing-queries.js";

export const modeDialMutationOptions = (
  queryClient: QueryClient,
  target: ModelRoutingTarget = { scope: "personal" },
) => {
  // A workspace change also moves members' inherited personal values.
  const invalidate = () => {
    void queryClient.invalidateQueries({
      queryKey:
        target.scope === "personal"
          ? modelRoutingKey(target)
          : modelRoutingKey(target).slice(0, 1),
    });
  };
  return {
    save: {
      mutationFn: (input: {
        mode: ModeId;
        config: typeof PutModeRequestSchema.Encoded;
      }) =>
        target.scope === "personal"
          ? putProfileMode(input.mode, input.config)
          : putWorkspaceProfileMode(
              target.workspaceSlug,
              input.mode,
              input.config,
            ),
      onSettled: invalidate,
    },
    reset: {
      mutationFn: (mode: ModeId) =>
        target.scope === "personal"
          ? resetProfileMode(mode)
          : resetWorkspaceProfileMode(target.workspaceSlug, mode),
      onSettled: invalidate,
    },
  };
};
