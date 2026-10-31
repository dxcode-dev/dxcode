import type {
  PluginBundlePreviewData,
  PluginBundleUpdatePreviewData,
} from "@dx/api";
import type { PluginId, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  installPluginBundle,
  type PluginBundleUpload,
  type PluginsTarget,
  previewPluginBundle,
  previewPluginBundleUpdate,
  removePluginBundle,
  setPluginBundleEnabled,
  updatePluginBundle,
} from "../../../shared/api/client.js";
import { mcpServerKeys } from "../integrations/mcp-queries.js";
import { skillKeys } from "../skills/skills-queries.js";
import { pluginBundleKeys } from "./plugin-bundle-queries.js";

export type { PluginBundleUpload };

export type PluginBundleAction =
  | {
      readonly type: "install";
      readonly upload: PluginBundleUpload;
      readonly preview: PluginBundlePreviewData;
    }
  | {
      readonly type: "enabled";
      readonly pluginId: PluginId;
      readonly enabled: boolean;
    }
  | {
      readonly type: "update";
      readonly pluginId: PluginId;
      readonly preview: PluginBundleUpdatePreviewData;
      /** The new ZIP, for a plugin imported from one. */
      readonly file?: File;
    }
  | { readonly type: "remove"; readonly pluginId: PluginId };

const mutate = async (
  target: PluginsTarget,
  action: PluginBundleAction,
): Promise<void> => {
  switch (action.type) {
    case "install":
      await installPluginBundle(target, action.upload, action.preview);
      return;
    case "enabled":
      await setPluginBundleEnabled(target, action.pluginId, action.enabled);
      return;
    case "update":
      await updatePluginBundle(
        target,
        action.pluginId,
        action.preview,
        action.file,
      );
      return;
    case "remove":
      await removePluginBundle(target, action.pluginId);
      return;
  }
};

export const pluginBundlesMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...pluginBundleKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: PluginBundleAction) => mutate(target, action),
    // A bundle installs and removes skills and MCP servers too.
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: pluginBundleKeys.all(userId),
        }),
        queryClient.invalidateQueries({ queryKey: skillKeys.all(userId) }),
        queryClient.invalidateQueries({ queryKey: mcpServerKeys.all(userId) }),
      ]),
  });

/** Reads an installed bundle's source again; installs nothing. */
export const pluginBundleUpdatePreviewMutationOptions = (
  target: PluginsTarget,
) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: ({
      pluginId,
      file,
    }: {
      readonly pluginId: PluginId;
      readonly file?: File;
    }) => previewPluginBundleUpdate(target, pluginId, file),
  });

/** Reads a bundle without installing anything; nothing is cached. */
export const pluginBundlePreviewMutationOptions = (target: PluginsTarget) =>
  mutationOptions({
    gcTime: 0,
    mutationFn: (upload: PluginBundleUpload) =>
      previewPluginBundle(target, upload),
  });
