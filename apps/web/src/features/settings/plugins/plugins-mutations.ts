import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  previewPlugin,
  publishPluginVersion,
  removePlugin,
  trustPlugin,
  updatePluginState,
  updatePluginWorkspacePolicy,
} from "../../../shared/api/client.js";
import { type PluginsTarget, pluginKeys } from "./plugins-queries.js";

export type PluginsMutationAction =
  | {
      readonly type: "trust";
      readonly bundle: Parameters<typeof trustPlugin>[1];
      readonly reviewedIntegrity: Parameters<typeof trustPlugin>[2];
      readonly grants: Parameters<typeof trustPlugin>[3];
    }
  | {
      readonly type: "publishVersion";
      readonly pluginId: Parameters<typeof publishPluginVersion>[1];
      readonly bundle: Parameters<typeof publishPluginVersion>[2];
      readonly reviewedIntegrity: Parameters<typeof publishPluginVersion>[3];
      readonly grants: Parameters<typeof publishPluginVersion>[4];
    }
  | {
      readonly type: "updateState";
      readonly pluginId: Parameters<typeof updatePluginState>[1];
      readonly input: Parameters<typeof updatePluginState>[2];
    }
  | {
      readonly type: "remove";
      readonly pluginId: Parameters<typeof removePlugin>[1];
    }
  | { readonly type: "updatePolicy"; readonly allowPersonalPlugins: boolean };

export type PluginPreview = Awaited<ReturnType<typeof previewPlugin>>;

const mutatePlugins = async (
  target: PluginsTarget,
  action: PluginsMutationAction,
) => {
  switch (action.type) {
    case "trust":
      return await trustPlugin(
        target,
        action.bundle,
        action.reviewedIntegrity,
        action.grants,
      );
    case "publishVersion":
      return await publishPluginVersion(
        target,
        action.pluginId,
        action.bundle,
        action.reviewedIntegrity,
        action.grants,
      );
    case "updateState":
      return await updatePluginState(target, action.pluginId, action.input);
    case "remove":
      return await removePlugin(target, action.pluginId);
    case "updatePolicy": {
      if (target.scope !== "workspace")
        throw new Error("Plugin workspace policy requires a workspace target.");
      return await updatePluginWorkspacePolicy(
        target,
        action.allowPersonalPlugins,
      );
    }
  }
};

export const pluginsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...pluginKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: PluginsMutationAction) =>
      mutatePlugins(target, action),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: pluginKeys.list(userId, target),
      }),
  });

export const pluginPreviewMutationOptions = (
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...pluginKeys.list(userId, target), "preview"],
    mutationFn: (bundle: Parameters<typeof previewPlugin>[1]) =>
      previewPlugin(target, bundle),
    gcTime: 0,
    onSuccess: () => undefined,
  });
