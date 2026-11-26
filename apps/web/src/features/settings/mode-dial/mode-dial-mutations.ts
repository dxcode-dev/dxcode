import type { PutModeRequestSchema } from "@dx/api";
import {
  PutPersonalProfileModeEndpoint,
  PutWorkspaceProfileModeEndpoint,
  ResetPersonalProfileModeEndpoint,
  ResetWorkspaceProfileModeEndpoint,
} from "@dx/api";
import type { ModeId, WorkspaceSlug } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  dxClient,
  type ModelRoutingTarget,
} from "../../../shared/api/client.js";
import { modelRoutingKey } from "../model-routing/model-routing-queries.js";

/** Callers pass the mode they read; Core refuses one it does not know. */
const modeParams = (mode: string) => ({ mode: mode as ModeId });

const putProfileMode = async (
  mode: string,
  config: typeof PutModeRequestSchema.Encoded,
) =>
  (
    await dxClient.call(PutPersonalProfileModeEndpoint, {
      params: modeParams(mode),
      body: config,
    })
  ).data;

const resetProfileMode = async (mode: string) =>
  (
    await dxClient.call(ResetPersonalProfileModeEndpoint, {
      params: modeParams(mode),
    })
  ).data;

const putWorkspaceProfileMode = async (
  workspaceSlug: WorkspaceSlug,
  mode: string,
  config: typeof PutModeRequestSchema.Encoded,
) =>
  (
    await dxClient.call(PutWorkspaceProfileModeEndpoint, {
      params: { workspaceSlug, ...modeParams(mode) },
      body: config,
    })
  ).data;

const resetWorkspaceProfileMode = async (
  workspaceSlug: WorkspaceSlug,
  mode: string,
) =>
  (
    await dxClient.call(ResetWorkspaceProfileModeEndpoint, {
      params: { workspaceSlug, ...modeParams(mode) },
    })
  ).data;

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
