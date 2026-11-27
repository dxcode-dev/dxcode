import {
  GetPersonalPluginOrbEndpoint,
  GetPluginPluginOrbEndpoint,
  GetWorkspacePluginOrbEndpoint,
  type PluginOrbData,
  UpdatePersonalPluginOrbEndpoint,
  UpdatePluginPluginOrbEndpoint,
  UpdateWorkspacePluginOrbEndpoint,
} from "@dx/api";
import type { RunnerProfileId, UserId } from "@dx/domain";
import {
  mutationOptions,
  type QueryClient,
  queryOptions,
} from "@tanstack/react-query";
import { ApiError, dxClient } from "../../../shared/api/client.js";
import type { PluginsTarget } from "../plugins/plugins-queries.js";

/**
 * Where plugins' programs run: Settings → Orb Providers → Plugins for a
 * person or a workspace, or one plugin's own choice ("Runs on").
 */
export type PluginOrbTarget =
  | PluginsTarget
  | { readonly scope: "plugin"; readonly pluginId: string };

/** Reads the target's choice through its `@dx/api` endpoint. */
const read = async (
  target: PluginOrbTarget,
  signal: AbortSignal,
): Promise<PluginOrbData> =>
  (target.scope === "personal"
    ? await dxClient.call(GetPersonalPluginOrbEndpoint, {}, { signal })
    : target.scope === "plugin"
      ? await dxClient.call(
          GetPluginPluginOrbEndpoint,
          { params: { pluginId: target.pluginId } },
          { signal },
        )
      : await dxClient.call(
          GetWorkspacePluginOrbEndpoint,
          { params: { workspaceSlug: target.workspaceSlug } },
          { signal },
        )
  ).data;

/** Saves the target's choice through its `@dx/api` endpoint. */
const write = async (
  target: PluginOrbTarget,
  runnerProfileId: RunnerProfileId | null,
): Promise<PluginOrbData> =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalPluginOrbEndpoint, {
        body: { runnerProfileId },
      })
    : target.scope === "plugin"
      ? await dxClient.call(UpdatePluginPluginOrbEndpoint, {
          params: { pluginId: target.pluginId },
          body: { runnerProfileId },
        })
      : await dxClient.call(UpdateWorkspacePluginOrbEndpoint, {
          params: { workspaceSlug: target.workspaceSlug },
          body: { runnerProfileId },
        })
  ).data;

const keys = (userId: UserId, target: PluginOrbTarget) =>
  ["plugin-orb", userId, target] as const;

export const pluginOrbQueryOptions = (
  userId: UserId,
  target: PluginOrbTarget,
) =>
  queryOptions({
    queryKey: keys(userId, target),
    queryFn: ({ signal }) => read(target, signal),
    staleTime: 30_000,
  });

export const pluginOrbSaveOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginOrbTarget,
) =>
  mutationOptions({
    mutationFn: (runnerProfileId: RunnerProfileId | null) =>
      write(target, runnerProfileId),
    onSuccess: (data) => {
      queryClient.setQueryData(keys(userId, target), data);
      // Every other scope's "what applies" may change with this one.
      return queryClient.invalidateQueries({
        queryKey: ["plugin-orb", userId],
      });
    },
  });

/** Why a save failed, as the API explained it, or a plain fallback. */
export const pluginOrbErrorText = (error: unknown) =>
  error instanceof ApiError ? error.message : "It wasn't saved. Try again.";
