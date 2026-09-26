import type { ProjectDefaultsData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  getProjectDefaults,
  type ProjectDefaultsTarget,
} from "../../../shared/api/client.js";

export type { ProjectDefaultsData, ProjectDefaultsTarget };

export const projectDefaultsKeys = {
  all: (userId: UserId) => ["project-defaults", userId] as const,
  detail: (userId: UserId, target: ProjectDefaultsTarget) =>
    [...projectDefaultsKeys.all(userId), target] as const,
};

export const projectDefaultsQueryOptions = (
  userId: UserId,
  target: ProjectDefaultsTarget,
) =>
  queryOptions({
    queryKey: projectDefaultsKeys.detail(userId, target),
    queryFn: ({ signal }) => getProjectDefaults(target, signal),
    staleTime: 30_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
