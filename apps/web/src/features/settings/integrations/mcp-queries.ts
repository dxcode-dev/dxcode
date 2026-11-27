import type {
  EnvironmentVariableData,
  McpServerData,
  McpToolData,
  ProjectData,
} from "@dx/api";
import {
  ListPersonalMcpServersEndpoint,
  ListWorkspaceMcpServersEndpoint,
} from "@dx/api";
import type {
  EnvironmentVariableConfigReference,
  UserId,
  WorkspaceSlug,
} from "@dx/domain";
import { queryOptions } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";

export const listMcpServers = async (
  target: McpServersTarget,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalMcpServersEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspaceMcpServersEndpoint,
        { params: { workspaceSlug: target.workspaceSlug } },
        { signal },
      )
  ).data;

export type {
  EnvironmentVariableData,
  McpServerData,
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

export type McpServersTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export interface McpServerInput {
  readonly name: string;
  readonly endpoint: string;
  /** `auto` lets the server decide between no auth, OAuth, and a token. */
  readonly authType?: "auto" | "none" | "bearer" | "oauth";
  readonly authReference?: EnvironmentVariableConfigReference;
  /** Write-only bearer token, stored encrypted on the server. */
  readonly authToken?: string;
  /** The module Code imports the server's tools under. */
  readonly moduleId?: string;
  /** Sent as the MCP client name; empty restores the default. */
  readonly clientName?: string;
  /** An own OAuth app; empty removes it. */
  readonly oauthClientId?: string;
  /** Write-only. */
  readonly oauthClientSecret?: string;
  /** The full header list; a secret without a value keeps its stored value. */
  readonly headers?: ReadonlyArray<{
    readonly name: string;
    readonly value?: string;
    readonly secret?: boolean;
  }>;
  readonly timeoutMs: number;
  /** Omitted: the server is available to all projects (API default). */
  readonly projectIds?: ReadonlyArray<string>;
  /** Omitted: all workspace roles (API default). */
  readonly roles?: ReadonlyArray<string>;
}
