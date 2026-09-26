import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { getGitHubIntegrationStatus } from "../../../shared/api/client.js";
import { settingsKeys } from "../settings-context-queries.js";

export const integrationKeys = {
  all: (userId: UserId) =>
    [...settingsKeys.all(userId), "integrations"] as const,
  personal: (userId: UserId) =>
    [...integrationKeys.all(userId), "personal"] as const,
  github: (userId: UserId) =>
    [...integrationKeys.personal(userId), "github"] as const,
};

export const githubIntegrationQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: integrationKeys.github(userId),
    queryFn: ({ signal }) => getGitHubIntegrationStatus(signal),
    staleTime: 30_000,
    retry: false,
  });
