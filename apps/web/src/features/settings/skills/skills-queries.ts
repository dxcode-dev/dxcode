import type { SkillData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { listSkills, type SkillsTarget } from "../../../shared/api/client.js";

export type { SkillData, SkillsTarget };

export const skillKeys = {
  all: (userId: UserId) => ["skills", userId] as const,
  list: (userId: UserId, target: SkillsTarget) =>
    [...skillKeys.all(userId), target] as const,
};

export const skillsQueryOptions = (userId: UserId, target: SkillsTarget) =>
  queryOptions({
    queryKey: skillKeys.list(userId, target),
    queryFn: ({ signal }) => listSkills(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
