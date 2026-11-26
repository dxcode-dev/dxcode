import { WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { defineEndpoint } from "../http/endpoint.js";
import {
  BeginMcpOAuthResponseSchema,
  CreateMcpServerRequestSchema,
  CreateMcpServerResponseSchema,
  DeleteMcpServerResponseSchema,
  DiscoverMcpServerResponseSchema,
  ListMcpServersResponseSchema,
  McpServerDiscoveryFailedResponseSchema,
  McpServerLimitResponseSchema,
  McpServerNotFoundResponseSchema,
  McpServerOAuthFailedResponseSchema,
  McpServerParamsSchema,
  McpServersBrowserSessionRequiredResponseSchema,
  McpServersForbiddenResponseSchema,
  McpServersInvalidRequestResponseSchema,
  McpServersPolicyDeniedResponseSchema,
  McpServersUnavailableResponseSchema,
  McpToolParamsSchema,
  ReviewMcpToolRequestSchema,
  ReviewMcpToolResponseSchema,
  SignOutMcpOAuthResponseSchema,
  UpdateMcpServerRequestSchema,
  UpdateMcpServerResponseSchema,
  UpdateMcpWorkspacePolicyRequestSchema,
  UpdateMcpWorkspacePolicyResponseSchema,
} from "./mcp-servers.js";

/**
 * The endpoints over `mcp-servers.ts`. In their own module, so code that imports
 * only the schemas, such as the Thread page, does not carry them
 * (wiki/headless-client.md).
 */

/** `discover` and `oauth/authorize` take an empty JSON object. */
export const McpServerEmptyRequestSchema = Schema.Struct({});

const mcpServersRefusals = [
  { status: 400, schema: McpServersInvalidRequestResponseSchema },
  { status: 403, schema: McpServersForbiddenResponseSchema },
  { status: 403, schema: McpServersBrowserSessionRequiredResponseSchema },
  { status: 404, schema: McpServerNotFoundResponseSchema },
  { status: 409, schema: McpServerLimitResponseSchema },
  { status: 502, schema: McpServerDiscoveryFailedResponseSchema },
  { status: 502, schema: McpServerOAuthFailedResponseSchema },
  { status: 403, schema: McpServersPolicyDeniedResponseSchema },
  { status: 503, schema: McpServersUnavailableResponseSchema },
];

const McpServersPersonalPath = "/v1/settings/personal/mcp-servers";
const McpServersWorkspacePath =
  "/v1/settings/workspaces/:workspaceSlug/mcp-servers";

export const WorkspaceMcpServersParamsSchema = Schema.Struct({
  workspaceSlug: WorkspaceSlug,
});

export const ListPersonalMcpServersEndpoint = defineEndpoint({
  id: "mcpServers.personal.list",
  method: "GET",
  path: `${McpServersPersonalPath}`,
  success: ListMcpServersResponseSchema,
  refusals: mcpServersRefusals,
});

export const ListWorkspaceMcpServersEndpoint = defineEndpoint({
  id: "mcpServers.workspace.list",
  method: "GET",
  path: `${McpServersWorkspacePath}`,
  params: WorkspaceMcpServersParamsSchema,
  success: ListMcpServersResponseSchema,
  refusals: mcpServersRefusals,
});

export const CreatePersonalMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.personal.create",
  method: "POST",
  path: `${McpServersPersonalPath}`,
  body: CreateMcpServerRequestSchema,
  success: CreateMcpServerResponseSchema,
  successStatus: 201,
  refusals: mcpServersRefusals,
});

export const CreateWorkspaceMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.workspace.create",
  method: "POST",
  path: `${McpServersWorkspacePath}`,
  params: WorkspaceMcpServersParamsSchema,
  body: CreateMcpServerRequestSchema,
  success: CreateMcpServerResponseSchema,
  successStatus: 201,
  refusals: mcpServersRefusals,
});

export const UpdatePersonalMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.personal.update",
  method: "PATCH",
  path: `${McpServersPersonalPath}/:mcpServerId`,
  params: McpServerParamsSchema,
  body: UpdateMcpServerRequestSchema,
  success: UpdateMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const UpdateWorkspaceMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.workspace.update",
  method: "PATCH",
  path: `${McpServersWorkspacePath}/:mcpServerId`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpServerParamsSchema.fields,
  }),
  body: UpdateMcpServerRequestSchema,
  success: UpdateMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const DiscoverPersonalMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.personal.discover",
  method: "POST",
  path: `${McpServersPersonalPath}/:mcpServerId/discover`,
  params: McpServerParamsSchema,
  body: McpServerEmptyRequestSchema,
  success: DiscoverMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const DiscoverWorkspaceMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.workspace.discover",
  method: "POST",
  path: `${McpServersWorkspacePath}/:mcpServerId/discover`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpServerParamsSchema.fields,
  }),
  body: McpServerEmptyRequestSchema,
  success: DiscoverMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const ReviewPersonalMcpToolEndpoint = defineEndpoint({
  id: "mcpServers.personal.reviewTool",
  method: "POST",
  path: `${McpServersPersonalPath}/:mcpServerId/tools/:toolName/review`,
  params: McpToolParamsSchema,
  body: ReviewMcpToolRequestSchema,
  success: ReviewMcpToolResponseSchema,
  refusals: mcpServersRefusals,
});

export const ReviewWorkspaceMcpToolEndpoint = defineEndpoint({
  id: "mcpServers.workspace.reviewTool",
  method: "POST",
  path: `${McpServersWorkspacePath}/:mcpServerId/tools/:toolName/review`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpToolParamsSchema.fields,
  }),
  body: ReviewMcpToolRequestSchema,
  success: ReviewMcpToolResponseSchema,
  refusals: mcpServersRefusals,
});

export const BeginPersonalMcpOAuthEndpoint = defineEndpoint({
  id: "mcpServers.personal.oauthBegin",
  method: "POST",
  path: `${McpServersPersonalPath}/:mcpServerId/oauth/authorize`,
  params: McpServerParamsSchema,
  body: McpServerEmptyRequestSchema,
  success: BeginMcpOAuthResponseSchema,
  successStatus: 201,
  refusals: mcpServersRefusals,
});

export const BeginWorkspaceMcpOAuthEndpoint = defineEndpoint({
  id: "mcpServers.workspace.oauthBegin",
  method: "POST",
  path: `${McpServersWorkspacePath}/:mcpServerId/oauth/authorize`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpServerParamsSchema.fields,
  }),
  body: McpServerEmptyRequestSchema,
  success: BeginMcpOAuthResponseSchema,
  successStatus: 201,
  refusals: mcpServersRefusals,
});

export const SignOutPersonalMcpOAuthEndpoint = defineEndpoint({
  id: "mcpServers.personal.oauthSignOut",
  method: "DELETE",
  path: `${McpServersPersonalPath}/:mcpServerId/oauth`,
  params: McpServerParamsSchema,
  success: SignOutMcpOAuthResponseSchema,
  refusals: mcpServersRefusals,
});

export const SignOutWorkspaceMcpOAuthEndpoint = defineEndpoint({
  id: "mcpServers.workspace.oauthSignOut",
  method: "DELETE",
  path: `${McpServersWorkspacePath}/:mcpServerId/oauth`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpServerParamsSchema.fields,
  }),
  success: SignOutMcpOAuthResponseSchema,
  refusals: mcpServersRefusals,
});

export const DeletePersonalMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.personal.delete",
  method: "DELETE",
  path: `${McpServersPersonalPath}/:mcpServerId`,
  params: McpServerParamsSchema,
  success: DeleteMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const DeleteWorkspaceMcpServerEndpoint = defineEndpoint({
  id: "mcpServers.workspace.delete",
  method: "DELETE",
  path: `${McpServersWorkspacePath}/:mcpServerId`,
  params: Schema.Struct({
    ...WorkspaceMcpServersParamsSchema.fields,
    ...McpServerParamsSchema.fields,
  }),
  success: DeleteMcpServerResponseSchema,
  refusals: mcpServersRefusals,
});

export const UpdateWorkspaceMcpPolicyEndpoint = defineEndpoint({
  id: "mcpServers.workspace.policy",
  method: "PATCH",
  path: `${McpServersWorkspacePath}/policy`,
  params: WorkspaceMcpServersParamsSchema,
  body: UpdateMcpWorkspacePolicyRequestSchema,
  success: UpdateMcpWorkspacePolicyResponseSchema,
  refusals: mcpServersRefusals,
});
