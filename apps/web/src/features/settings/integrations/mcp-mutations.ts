import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  createMcpServer,
  deleteMcpServer,
  discoverMcpServer,
  reviewMcpTool,
  updateMcpServer,
  updateMcpWorkspacePolicy,
} from "../../../shared/api/client.js";
import { type McpServersTarget, mcpServerKeys } from "./mcp-queries.js";

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
