import {
  BeginPersonalMcpOAuthEndpoint,
  BeginWorkspaceMcpOAuthEndpoint,
  CreatePersonalMcpServerEndpoint,
  CreateWorkspaceMcpServerEndpoint,
  DeletePersonalMcpServerEndpoint,
  DeleteWorkspaceMcpServerEndpoint,
  DiscoverPersonalMcpServerEndpoint,
  DiscoverWorkspaceMcpServerEndpoint,
  ReviewPersonalMcpToolEndpoint,
  ReviewWorkspaceMcpToolEndpoint,
  SignOutPersonalMcpOAuthEndpoint,
  SignOutWorkspaceMcpOAuthEndpoint,
  UpdatePersonalMcpServerEndpoint,
  UpdateWorkspaceMcpPolicyEndpoint,
  UpdateWorkspaceMcpServerEndpoint,
} from "@dx/api";
import type {
  EnvironmentVariableConfigReference,
  McpServerId,
  McpToolName,
  McpToolSchemaHash,
  UserId,
} from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import { dxClient } from "../../../shared/api/client.js";
import {
  type McpServerData,
  type McpServerInput,
  type McpServersTarget,
  mcpServerKeys,
} from "./mcp-queries.js";

const createMcpServer = async (
  target: McpServersTarget,
  input: McpServerInput,
): Promise<McpServerData> =>
  (target.scope === "personal"
    ? await dxClient.call(CreatePersonalMcpServerEndpoint, { body: input })
    : await dxClient.call(CreateWorkspaceMcpServerEndpoint, {
        params: { workspaceSlug: target.workspaceSlug },
        body: input,
      })
  ).data;

const updateMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
  input: Omit<Partial<McpServerInput>, "authReference" | "authType"> & {
    readonly authType?: "none" | "bearer" | "oauth";
    readonly authReference?: EnvironmentVariableConfigReference | null;
    readonly enabled?: boolean;
  },
): Promise<McpServerData> =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalMcpServerEndpoint, {
        params: { mcpServerId: serverId },
        body: input,
      })
    : await dxClient.call(UpdateWorkspaceMcpServerEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, mcpServerId: serverId },
        body: input,
      })
  ).data;

const discoverMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<McpServerData> =>
  (target.scope === "personal"
    ? await dxClient.call(DiscoverPersonalMcpServerEndpoint, {
        params: { mcpServerId: serverId },
        body: {},
      })
    : await dxClient.call(DiscoverWorkspaceMcpServerEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, mcpServerId: serverId },
        body: {},
      })
  ).data;

const reviewMcpTool = async (
  target: McpServersTarget,
  serverId: McpServerId,
  toolName: McpToolName,
  schemaHash: McpToolSchemaHash,
  approved: boolean,
): Promise<McpServerData> =>
  (target.scope === "personal"
    ? await dxClient.call(ReviewPersonalMcpToolEndpoint, {
        params: { mcpServerId: serverId, toolName },
        body: { schemaHash, approved },
      })
    : await dxClient.call(ReviewWorkspaceMcpToolEndpoint, {
        params: {
          workspaceSlug: target.workspaceSlug,
          mcpServerId: serverId,
          toolName,
        },
        body: { schemaHash, approved },
      })
  ).data;

/** Starts an OAuth sign-in; the caller sends the browser to the returned URL. */
const beginMcpOAuth = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<string> =>
  (target.scope === "personal"
    ? await dxClient.call(BeginPersonalMcpOAuthEndpoint, {
        params: { mcpServerId: serverId },
        body: {},
      })
    : await dxClient.call(BeginWorkspaceMcpOAuthEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, mcpServerId: serverId },
        body: {},
      })
  ).data.authorizationUrl;

/** Removes the person's own sign-in to the server. */
const signOutMcpOAuth = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<McpServerData> =>
  (target.scope === "personal"
    ? await dxClient.call(SignOutPersonalMcpOAuthEndpoint, {
        params: { mcpServerId: serverId },
      })
    : await dxClient.call(SignOutWorkspaceMcpOAuthEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, mcpServerId: serverId },
      })
  ).data;

const deleteMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<McpServerId> =>
  (target.scope === "personal"
    ? await dxClient.call(DeletePersonalMcpServerEndpoint, {
        params: { mcpServerId: serverId },
      })
    : await dxClient.call(DeleteWorkspaceMcpServerEndpoint, {
        params: { workspaceSlug: target.workspaceSlug, mcpServerId: serverId },
      })
  ).data.deletedMcpServerId;

const updateMcpWorkspacePolicy = async (
  target: Extract<McpServersTarget, { readonly scope: "workspace" }>,
  allowPersonalServers: boolean,
): Promise<boolean> =>
  (
    await dxClient.call(UpdateWorkspaceMcpPolicyEndpoint, {
      params: { workspaceSlug: target.workspaceSlug },
      body: { allowPersonalServers },
    })
  ).data.allowPersonalServers;

export type McpServersMutationAction =
  | {
      readonly type: "create";
      readonly input: Parameters<typeof createMcpServer>[1];
    }
  | {
      readonly type: "update";
      readonly serverId: Parameters<typeof updateMcpServer>[1];
      readonly input: Parameters<typeof updateMcpServer>[2];
    }
  | {
      readonly type: "discover";
      readonly serverId: Parameters<typeof discoverMcpServer>[1];
    }
  | {
      readonly type: "reviewTool";
      readonly serverId: Parameters<typeof reviewMcpTool>[1];
      readonly toolName: Parameters<typeof reviewMcpTool>[2];
      readonly schemaHash: Parameters<typeof reviewMcpTool>[3];
      readonly approved: boolean;
    }
  | {
      readonly type: "signOut";
      readonly serverId: Parameters<typeof signOutMcpOAuth>[1];
    }
  | {
      readonly type: "delete";
      readonly serverId: Parameters<typeof deleteMcpServer>[1];
    }
  | { readonly type: "updatePolicy"; readonly allowPersonalServers: boolean };

const mutateMcpServers = async (
  target: McpServersTarget,
  action: McpServersMutationAction,
) => {
  switch (action.type) {
    case "create":
      return await createMcpServer(target, action.input);
    case "update":
      return await updateMcpServer(target, action.serverId, action.input);
    case "discover":
      return await discoverMcpServer(target, action.serverId);
    case "reviewTool":
      return await reviewMcpTool(
        target,
        action.serverId,
        action.toolName,
        action.schemaHash,
        action.approved,
      );
    case "signOut":
      return await signOutMcpOAuth(target, action.serverId);
    case "delete":
      return await deleteMcpServer(target, action.serverId);
    case "updatePolicy": {
      if (target.scope !== "workspace")
        throw new Error("MCP workspace policy requires a workspace target.");
      return await updateMcpWorkspacePolicy(
        target,
        action.allowPersonalServers,
      );
    }
  }
};

export const mcpServersMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: McpServersTarget,
) =>
  mutationOptions({
    mutationKey: [...mcpServerKeys.list(userId, target), "mutate"],
    mutationFn: (action: McpServersMutationAction) =>
      mutateMcpServers(target, action),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: mcpServerKeys.list(userId, target),
      }),
  });

/** Starts an OAuth sign-in and returns the provider URL to send the browser to. */
export const beginMcpServerSignIn = (
  target: McpServersTarget,
  serverId: Parameters<typeof beginMcpOAuth>[1],
) => beginMcpOAuth(target, serverId);
