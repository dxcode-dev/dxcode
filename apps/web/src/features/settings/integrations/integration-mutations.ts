import {
  BeginGitHubAuthorizationEndpoint,
  BeginGitHubInstallationEndpoint,
  DisconnectGitHubEndpoint,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import { sourceGrantKeys } from "../../projects/source-grant-queries.js";
import { integrationKeys } from "./integration-queries.js";

/** Where GitHub sends the person back to, when the caller names it. */
const returnToQuery = (returnTo?: string) =>
  returnTo === undefined ? {} : { return_to: returnTo };

/** Starts GitHub sign-in; answers the address to open. */
export const beginPersonalGitHubAuthorization = async (returnTo?: string) =>
  (
    await dxClient.call(BeginGitHubAuthorizationEndpoint, {
      query: returnToQuery(returnTo),
    })
  ).data.authorizationUrl;

/** Starts installing the GitHub App; answers the address to open. */
export const beginPersonalGitHubInstallation = async (returnTo?: string) =>
  (
    await dxClient.call(BeginGitHubInstallationEndpoint, {
      query: returnToQuery(returnTo),
    })
  ).data.installationUrl;

export const githubDisconnectMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  grantId: string,
) =>
  mutationOptions({
    mutationKey: [...sourceGrantKeys.personal(userId), "disconnect"] as const,
    mutationFn: async () => {
      await dxClient.call(DisconnectGitHubEndpoint, { params: { grantId } });
    },
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
