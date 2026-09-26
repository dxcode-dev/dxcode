import {
  EnvironmentVariableConfigReference,
  McpHealthStatus,
  McpServerEndpoint,
  McpServerId,
  McpServerName,
  McpServerProjectGrants,
  McpServerRoleGrants,
  McpServerScope,
  McpServerTimeoutMs,
  McpServerTransport,
  McpToolDescription,
  McpToolName,
  McpToolSchemaHash,
  Timestamp,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

const McpNameInput = Schema.String.check(Schema.isMaxLength(80));
const McpEndpointInput = Schema.String.check(Schema.isMaxLength(2_048));
const McpProjectGrantInputs = Schema.Array(
  Schema.String.check(Schema.isMaxLength(128)),
).check(Schema.isMaxLength(100));
const McpRoleGrantInputs = Schema.Array(
  Schema.String.check(Schema.isMaxLength(16)),
).check(Schema.isMaxLength(3));

export const McpToolDataSchema = Schema.Struct({
  name: McpToolName,
  description: McpToolDescription,
  inputSchema: Schema.Unknown,
  schemaHash: McpToolSchemaHash,
  approved: Schema.Boolean,
  reviewRequired: Schema.Boolean,
  discoveredAt: Timestamp,
  reviewedAt: Schema.optional(Timestamp),
});

export type McpToolData = typeof McpToolDataSchema.Type;

export const McpServerDataSchema = Schema.Struct({
  id: McpServerId,
  scope: McpServerScope,
  name: McpServerName,
  endpoint: McpServerEndpoint,
  transport: McpServerTransport,
  authReference: Schema.optional(EnvironmentVariableConfigReference),
  timeoutMs: McpServerTimeoutMs,
  enabled: Schema.Boolean,
  projectIds: McpServerProjectGrants,
  roles: McpServerRoleGrants,
  healthStatus: McpHealthStatus,
  healthCheckedAt: Schema.optional(Timestamp),
  healthErrorCode: Schema.optional(Schema.String),
  tools: Schema.Array(McpToolDataSchema),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type McpServerData = typeof McpServerDataSchema.Type;

export const ListMcpServersResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(McpServerDataSchema),
    allowPersonalServers: Schema.optional(Schema.Boolean),
    canMutate: Schema.Boolean,
  }),
);

export const CreateMcpServerRequestSchema = Schema.Struct({
  name: McpNameInput,
  endpoint: McpEndpointInput,
  authReference: Schema.optional(EnvironmentVariableConfigReference),
  timeoutMs: Schema.Finite,
  projectIds: Schema.optional(McpProjectGrantInputs),
  roles: Schema.optional(McpRoleGrantInputs),
});

export const CreateMcpServerResponseSchema =
  successResponse(McpServerDataSchema);

export const McpServerParamsSchema = Schema.Struct({
  mcpServerId: McpServerId,
});

export const UpdateMcpServerRequestSchema = Schema.Struct({
  name: Schema.optional(McpNameInput),
  endpoint: Schema.optional(McpEndpointInput),
  authReference: Schema.optional(
    Schema.NullOr(EnvironmentVariableConfigReference),
  ),
  timeoutMs: Schema.optional(Schema.Finite),
  enabled: Schema.optional(Schema.Boolean),
  projectIds: Schema.optional(McpProjectGrantInputs),
  roles: Schema.optional(McpRoleGrantInputs),
});

export const UpdateMcpServerResponseSchema =
  successResponse(McpServerDataSchema);

export const DiscoverMcpServerResponseSchema =
  successResponse(McpServerDataSchema);

export const McpToolParamsSchema = Schema.Struct({
  mcpServerId: McpServerId,
  toolName: McpToolName,
});

export const ReviewMcpToolRequestSchema = Schema.Struct({
  schemaHash: McpToolSchemaHash,
  approved: Schema.Boolean,
});

export const ReviewMcpToolResponseSchema = successResponse(McpServerDataSchema);

export const DeleteMcpServerResponseSchema = successResponse(
  Schema.Struct({ deletedMcpServerId: McpServerId }),
);

export const UpdateMcpWorkspacePolicyRequestSchema = Schema.Struct({
  allowPersonalServers: Schema.Boolean,
});

export const UpdateMcpWorkspacePolicyResponseSchema = successResponse(
  Schema.Struct({ allowPersonalServers: Schema.Boolean }),
);

export const McpServersInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_MCP_SERVER_REQUEST"),
    message: Schema.Literal("MCP server validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const McpServersForbiddenResponseSchema = errorResponse(
  "SETTINGS_SCOPE_FORBIDDEN",
  "The settings scope is unavailable for this user.",
);

export const McpServersBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required to manage MCP servers.",
);

export const McpServerNotFoundResponseSchema = errorResponse(
  "MCP_SERVER_NOT_FOUND",
  "MCP server not found.",
);

export const McpServerLimitResponseSchema = errorResponse(
  "MCP_SERVER_LIMIT_EXCEEDED",
  "This scope has reached its MCP server limit.",
);

export const McpServerDiscoveryFailedResponseSchema = errorResponse(
  "MCP_SERVER_DISCOVERY_FAILED",
  "MCP server discovery failed.",
);

export const McpServersPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal("Workspace policy does not allow this MCP action."),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});

export const McpServersUnavailableResponseSchema = errorResponse(
  "MCP_SERVERS_UNAVAILABLE",
  "MCP servers are temporarily unavailable.",
);

export const McpServersErrorResponseSchema = Schema.Union([
  McpServersInvalidRequestResponseSchema,
  McpServersForbiddenResponseSchema,
  McpServersBrowserSessionRequiredResponseSchema,
  McpServerNotFoundResponseSchema,
  McpServerLimitResponseSchema,
  McpServerDiscoveryFailedResponseSchema,
  McpServersPolicyDeniedResponseSchema,
  McpServersUnavailableResponseSchema,
]);
