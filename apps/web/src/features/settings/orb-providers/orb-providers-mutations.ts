import type { OrbProviderId } from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  deleteOrbProviderKey,
  setOrbProviderKey,
  setOrbProviderWorkspacePolicy,
} from "../../../shared/api/client.js";
import {
  orbProviderKeys,
  type PluginsTarget,
} from "./orb-providers-queries.js";

export type OrbProviderAction =
  | {
      readonly type: "saveKey";
      readonly providerId: OrbProviderId;
      readonly credential: string;
    }
  | { readonly type: "removeKey"; readonly providerId: OrbProviderId }
  | {
      readonly type: "policy";
      readonly allowPersonalKeysOnWorkspaceProjects: boolean;
    };

const mutate = (target: PluginsTarget, action: OrbProviderAction) => {
  switch (action.type) {
    case "saveKey":
      return setOrbProviderKey(target, action.providerId, action.credential);
    case "removeKey":
      return deleteOrbProviderKey(target, action.providerId);
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
