import { ListGitHubGrantsEndpoint } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";

export const sourceGrantKeys = {
  personal: (userId: UserId) => ["source-grants", userId, "personal"] as const,
};

export const sourceGrantsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: sourceGrantKeys.personal(userId),
    queryFn: async ({ signal }) =>
      (await dxClient.call(ListGitHubGrantsEndpoint, {}, { signal })).data
        .grants,
    staleTime: 30_000,
    retry: false,
  });
