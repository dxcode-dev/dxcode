import type {
  ConfigurablePluginProviderId,
  SetFirstPartyPluginConfigurationRequest,
} from "@dx/api";
import {
  DeletePersonalFirstPartyPluginConfigurationEndpoint,
  DeleteWorkspaceFirstPartyPluginConfigurationEndpoint,
  SetPersonalFirstPartyPluginConfigurationEndpoint,
  SetPersonalFirstPartyPluginEnablementEndpoint,
  SetWorkspaceFirstPartyPluginConfigurationEndpoint,
  SetWorkspaceFirstPartyPluginEnablementEndpoint,
  SetWorkspaceFirstPartyPluginPolicyEndpoint,
} from "@dx/api";
import type { FirstPartyPluginId, UserId, WorkspaceSlug } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";
import { firstPartyPluginKeys, type PluginsTarget } from "./plugins-queries.js";

/** Callers pass any id; Core refuses one this deployment does not install. */
const firstPartyPluginId = (pluginId: string) => pluginId as FirstPartyPluginId;

/** First-party plugins (Search, …): enablement, provider, and credential per scope. */
const setFirstPartyPluginEnablement = async (
  target: PluginsTarget,
  pluginId: string,
  enablement: "enabled" | "disabled" | null,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalFirstPartyPluginEnablementEndpoint, {
        params: { pluginId: firstPartyPluginId(pluginId) },
        body: { enablement },
      })
    : await dxClient.call(SetWorkspaceFirstPartyPluginEnablementEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          pluginId: firstPartyPluginId(pluginId),
        },
        body: { enablement },
      })
  ).data;

const setFirstPartyPluginConfiguration = async (
  target: PluginsTarget,
  pluginId: string,
  input: SetFirstPartyPluginConfigurationRequest,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalFirstPartyPluginConfigurationEndpoint, {
        params: { pluginId: firstPartyPluginId(pluginId) },
        body: input,
      })
    : await dxClient.call(SetWorkspaceFirstPartyPluginConfigurationEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          pluginId: firstPartyPluginId(pluginId),
        },
        body: input,
      })
  ).data;

const deleteFirstPartyPluginConfiguration = async (
  target: PluginsTarget,
  pluginId: string,
) =>
  (target.scope === "personal"
    ? await dxClient.call(DeletePersonalFirstPartyPluginConfigurationEndpoint, {
        params: { pluginId: firstPartyPluginId(pluginId) },
      })
    : await dxClient.call(
        DeleteWorkspaceFirstPartyPluginConfigurationEndpoint,
        {
          params: {
            workspaceSlug: target.workspaceSlug,
            pluginId: firstPartyPluginId(pluginId),
          },
        },
      )
  ).data;

const setFirstPartyPluginWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  allowPersonalOverrides: boolean,
) =>
  (
    await dxClient.call(SetWorkspaceFirstPartyPluginPolicyEndpoint, {
      params: { workspaceSlug },
      body: { allowPersonalOverrides },
    })
  ).data;

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
