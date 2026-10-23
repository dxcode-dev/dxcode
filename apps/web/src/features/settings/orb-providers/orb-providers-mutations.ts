import type { OrbProviderId } from "@dx/api";
import type { OrbProviderCredentials, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteOrbProviderConnection,
  retryOrbProviderConnection,
  setOrbProviderConnection,
  setOrbProviderWorkspacePolicy,
} from "../../../shared/api/client.js";
import {
  orbProviderKeys,
  type PluginsTarget,
} from "./orb-providers-queries.js";

export type OrbProviderAction =
  | {
      readonly type: "connect";
      readonly providerId: OrbProviderId;
      readonly credentials: OrbProviderCredentials;
    }
  | { readonly type: "retry"; readonly providerId: OrbProviderId }
  | { readonly type: "disconnect"; readonly providerId: OrbProviderId }
  | {
      readonly type: "policy";
      readonly allowPersonalKeysOnWorkspaceProjects: boolean;
    };

const mutate = (target: PluginsTarget, action: OrbProviderAction) => {
  switch (action.type) {
    case "connect":
      return setOrbProviderConnection(
        target,
        action.providerId,
        action.credentials,
      );
    case "retry":
      return retryOrbProviderConnection(target, action.providerId);
    case "disconnect":
      return deleteOrbProviderConnection(target, action.providerId);
    case "policy":
      if (target.scope !== "workspace")
        throw new Error("Orb provider policy requires a workspace target.");
      return setOrbProviderWorkspacePolicy(
        target.workspaceSlug,
        action.allowPersonalKeysOnWorkspaceProjects,
      );
  }
};

export const orbProvidersMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: PluginsTarget,
) =>
  mutationOptions({
    mutationKey: [...orbProviderKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: OrbProviderAction) => mutate(target, action),
    onSuccess: (data) => {
      queryClient.setQueryData(orbProviderKeys.list(userId, target), data);
      // Personal, workspace, and the new-Thread picker all derive from the
      // same keys.
      return queryClient.invalidateQueries({
        queryKey: orbProviderKeys.all(userId),
      });
    },
  });
