import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  beginGitHubAuthorization,
  beginGitHubInstallation,
  disconnectGitHub,
} from "../../../shared/api/client.js";
import { sourceGrantKeys } from "../../projects/source-grant-queries.js";
import { integrationKeys } from "./integration-queries.js";

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
