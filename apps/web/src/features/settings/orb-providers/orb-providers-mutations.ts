import type { OrbProviderId } from "@dx/api";
import {
  DeletePersonalOrbProviderConnectionEndpoint,
  DeleteWorkspaceOrbProviderConnectionEndpoint,
  RetryPersonalOrbProviderConnectionEndpoint,
  RetryWorkspaceOrbProviderConnectionEndpoint,
  SetPersonalOrbProviderConnectionEndpoint,
  SetWorkspaceOrbProviderConnectionEndpoint,
  SetWorkspaceOrbProviderPolicyEndpoint,
} from "@dx/api";
import type { OrbProviderCredentials, UserId, WorkspaceSlug } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import {
  orbProviderKeys,
  type PluginsTarget,
} from "./orb-providers-queries.js";

const setOrbProviderConnection = async (
  target: PluginsTarget,
  providerId: OrbProviderId,
  credentials: OrbProviderCredentials,
) =>
  (target.scope === "personal"
    ? await dxClient.call(SetPersonalOrbProviderConnectionEndpoint, {
        params: { providerId },
        body: { credentials },
      })
    : await dxClient.call(SetWorkspaceOrbProviderConnectionEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, providerId },
        body: { credentials },
      })
  ).data;

const retryOrbProviderConnection = async (
  target: PluginsTarget,
  providerId: OrbProviderId,
) =>
  (target.scope === "personal"
    ? await dxClient.call(RetryPersonalOrbProviderConnectionEndpoint, {
        params: { providerId },
      })
    : await dxClient.call(RetryWorkspaceOrbProviderConnectionEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, providerId },
      })
  ).data;

const deleteOrbProviderConnection = async (
  target: PluginsTarget,
  providerId: OrbProviderId,
) =>
  (target.scope === "personal"
    ? await dxClient.call(DeletePersonalOrbProviderConnectionEndpoint, {
        params: { providerId },
      })
    : await dxClient.call(DeleteWorkspaceOrbProviderConnectionEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, providerId },
      })
  ).data;

const setOrbProviderWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  allowPersonalKeysOnWorkspaceProjects: boolean,
) =>
  (
    await dxClient.call(SetWorkspaceOrbProviderPolicyEndpoint, {
      params: { workspaceSlug },
      body: { allowPersonalKeysOnWorkspaceProjects },
    })
  ).data;

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
