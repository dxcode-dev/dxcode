import type {
  GitIntegrationProvider,
  IntegrationConnectionId,
  ProviderRepositoryId,
  UserId,
} from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  beginGitHubAuthorization,
  beginGitHubInstallation,
  beginIntegrationAuthorization,
  checkIntegrationHealth,
  disconnectGitHub,
  disconnectIntegration,
  refreshIntegration,
  selectIntegrationRepositories,
} from "../../../shared/api/client.js";
import { sourceGrantKeys } from "../../projects/source-grant-queries.js";
import { integrationKeys } from "./integration-queries.js";

type IntegrationMutation =
  | { readonly kind: "authorize"; readonly provider: GitIntegrationProvider }
  | {
      readonly kind: "disconnect";
      readonly connectionId: IntegrationConnectionId;
    }
  | { readonly kind: "refresh"; readonly connectionId: IntegrationConnectionId }
  | { readonly kind: "health"; readonly connectionId: IntegrationConnectionId }
  | {
      readonly kind: "repositories";
      readonly connectionId: IntegrationConnectionId;
      readonly repositoryIds: ReadonlyArray<ProviderRepositoryId>;
    };

export const beginPersonalGitHubAuthorization = (returnTo?: string) =>
  beginGitHubAuthorization(returnTo);

export const beginPersonalGitHubInstallation = (returnTo?: string) =>
  beginGitHubInstallation(returnTo);

export const githubDisconnectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  grantId: string,
) =>
  mutationOptions({
    mutationKey: [...sourceGrantKeys.personal(userId), "disconnect"] as const,
    mutationFn: () => disconnectGitHub(grantId),
    onSettled: () =>
      Promise.all([
        queryClient.invalidateQueries({
          queryKey: sourceGrantKeys.personal(userId),
        }),
        queryClient.invalidateQueries({
          queryKey: integrationKeys.github(userId),
        }),
      ]),
  });

export const integrationMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
) =>
  mutationOptions({
    mutationKey: [...integrationKeys.personal(userId), "mutate"] as const,
    mutationFn: async (mutation: IntegrationMutation) => {
      switch (mutation.kind) {
        case "authorize":
          return {
            authorizationUrl: await beginIntegrationAuthorization(
              mutation.provider,
            ),
          };
        case "disconnect":
          await disconnectIntegration(mutation.connectionId);
          return {};
        case "refresh":
          await refreshIntegration(mutation.connectionId);
          return {};
        case "health":
          await checkIntegrationHealth(mutation.connectionId);
          return {};
        case "repositories":
          await selectIntegrationRepositories(
            mutation.connectionId,
            mutation.repositoryIds,
          );
          return {};
      }
    },
    onSuccess: (_data, mutation) => {
      if (mutation.kind !== "authorize") {
        void queryClient.invalidateQueries({
          queryKey: integrationKeys.personal(userId),
        });
      }
    },
    gcTime: 0,
  });
