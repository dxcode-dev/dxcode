import type {
  EnvironmentVariableData,
  McpServerData,
  McpToolData,
  ProjectData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import {
  listMcpServers,
  type McpServerInput,
  type McpServersTarget,
} from "../../../shared/api/client.js";
import { projectsQueryOptions } from "../../projects/project-queries.js";

export type {
  EnvironmentVariableData,
  McpServerData,
  McpServerInput,
  McpServersTarget,
  McpToolData,
  ProjectData,
};

export const mcpServerKeys = {
  all: (userId: UserId) => ["mcp-servers", userId] as const,
  list: (userId: UserId, target: McpServersTarget) =>
    [...mcpServerKeys.all(userId), target] as const,
};

export const mcpServersQueryOptions = (
  userId: UserId,
  target: McpServersTarget,
) =>
  queryOptions({
    queryKey: mcpServerKeys.list(userId, target),
    queryFn: ({ signal }) => listMcpServers(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });

export const mcpServerProjectsQueryOptions = (userId: UserId) =>
  projectsQueryOptions(userId);
