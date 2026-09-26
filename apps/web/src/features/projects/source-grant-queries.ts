import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { listGitHubSourceGrants } from "../../shared/api/client.js";

export const sourceGrantKeys = {
  personal: (userId: UserId) => ["source-grants", userId, "personal"] as const,
};

export const sourceGrantsQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: sourceGrantKeys.personal(userId),
    queryFn: ({ signal }) => listGitHubSourceGrants(signal),
    staleTime: 30_000,
    retry: false,
  });
