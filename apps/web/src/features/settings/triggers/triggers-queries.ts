import type {
  EnvironmentVariableData,
  PluginTriggerData,
  TriggerPluginCapabilityData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { listPluginTriggers } from "../../../shared/api/client.js";

export type {
  EnvironmentVariableData,
  PluginTriggerData,
  TriggerPluginCapabilityData,
};

export const triggerKeys = {
  all: (userId: UserId) => ["plugin-triggers", userId] as const,
  list: (userId: UserId) => [...triggerKeys.all(userId), "list"] as const,
};

export const triggersQueryOptions = (userId: UserId) =>
  queryOptions({
    queryKey: triggerKeys.list(userId),
    queryFn: ({ signal }) => listPluginTriggers(signal),
    staleTime: 10_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
