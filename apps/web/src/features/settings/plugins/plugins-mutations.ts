import type { ConfigurablePluginProviderId } from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteFirstPartyPluginConfiguration,
  setFirstPartyPluginConfiguration,
  setFirstPartyPluginEnablement,
  setFirstPartyPluginWorkspacePolicy,
} from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";
import { firstPartyPluginKeys, type PluginsTarget } from "./plugins-queries.js";

export type FirstPartyPluginAction =
  | {
      readonly type: "enablement";
      readonly pluginId: string;
      readonly enablement: "enabled" | "disabled" | null;
    }
  | {
      readonly type: "configure";
      readonly pluginId: string;
      readonly providerId: typeof ConfigurablePluginProviderId.Type;
      readonly credential: string;
    }
  | { readonly type: "removeConfiguration"; readonly pluginId: string }
  | { readonly type: "policy"; readonly allowPersonalOverrides: boolean };

const mutate = (target: PluginsTarget, action: FirstPartyPluginAction) => {
  switch (action.type) {
    case "enablement":
      return setFirstPartyPluginEnablement(
        target,
        action.pluginId,
        action.enablement,
      );
    case "configure":
      return setFirstPartyPluginConfiguration(target, action.pluginId, {
        providerId: action.providerId,
        credential: action.credential,
      });
    case "removeConfiguration":
      return deleteFirstPartyPluginConfiguration(target, action.pluginId);
    case "policy":
      if (target.scope !== "workspace")
        throw new Error("Plugin policy requires a workspace target.");
      return setFirstPartyPluginWorkspacePolicy(
        target.workspaceSlug,
        action.allowPersonalOverrides,
      );
  }
};

export const firstPartyPluginsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...firstPartyPluginKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: FirstPartyPluginAction) => mutate(target, action),
    onSuccess: (data) => {
      queryClient.setQueryData(firstPartyPluginKeys.list(userId, target), data);
      // Personal and workspace views both derive from the same settings,
      // and the settings context derives dictation from Speech resolution.
      return Promise.all([
        queryClient.invalidateQueries({
          queryKey: firstPartyPluginKeys.all(userId),
        }),
        queryClient.invalidateQueries({
          queryKey: settingsKeys.contexts(userId),
        }),
      ]);
    },
  });
