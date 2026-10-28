import {
  EnvironmentVariableConfigReference,
  McpClientName,
  McpHeaderName,
  McpHealthStatus,
  McpModuleId,
  McpServerAuthType,
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
  /**
   * `allow`: agents can call it. `disabled`: someone turned it off.
   * `review`: never reviewed, or its contract changed since it was allowed.
   */
  policy: Schema.Literals(["allow", "disabled", "review"]),
  discoveredAt: Timestamp,
  reviewedAt: Schema.optional(Timestamp),
});

export type McpToolData = typeof McpToolDataSchema.Type;

/** A configured header; secret values are write-only and never returned. */
export const McpHeaderDataSchema = Schema.Struct({
  name: McpHeaderName,
  secret: Schema.Boolean,
  value: Schema.optional(Schema.String),
});

export type McpHeaderData = typeof McpHeaderDataSchema.Type;

export const McpServerDataSchema = Schema.Struct({
  id: McpServerId,
  scope: McpServerScope,
  name: McpServerName,
  /** The module name Code imports this server's tools under. */
  moduleId: McpModuleId,
  endpoint: McpServerEndpoint,
  transport: McpServerTransport,
  authType: McpServerAuthType,
  authReference: Schema.optional(EnvironmentVariableConfigReference),
  /** A bearer token is stored on the server; its value is never returned. */
  hasStoredToken: Schema.Boolean,
  clientName: Schema.optional(McpClientName),
  oauthClientId: Schema.optional(Schema.String),
  hasOAuthClientSecret: Schema.Boolean,
  /** Whether the person viewing has signed in to this OAuth server. */
  signedIn: Schema.Boolean,
  headers: Schema.Array(McpHeaderDataSchema),
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

/** Write-only bearer token, stored encrypted on the server. */
const McpAuthTokenInput = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(8_192),
);

/**
 * `auto` probes the server: no auth when it answers, OAuth when it
 * advertises an authorization server, otherwise a bearer token is required.
 */
export const McpAuthTypeInput = Schema.Literals([
  "auto",
  "none",
  "bearer",
  "oauth",
]);

const McpClientNameInput = Schema.String.check(Schema.isMaxLength(80));
const McpModuleIdInput = Schema.String.check(Schema.isMaxLength(64));
const McpOAuthClientIdInput = Schema.String.check(Schema.isMaxLength(512));
const McpOAuthClientSecretInput = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(4_096),
);

/**
 * The full header list. A secret header with no value keeps its stored
 * value; a new secret header needs one.
 */
export const McpHeaderInputSchema = Schema.Struct({
  name: Schema.String.check(Schema.isMaxLength(128)),
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
  secret: Schema.optional(Schema.Boolean),
});

const McpHeadersInput = Schema.Array(McpHeaderInputSchema).check(
  Schema.isMaxLength(32),
);

export const CreateMcpServerRequestSchema = Schema.Struct({
  name: McpNameInput,
  endpoint: McpEndpointInput,
  /** Defaults to `bearer` with an `authToken`, otherwise `none`. */
  authType: Schema.optional(McpAuthTypeInput),
  authReference: Schema.optional(EnvironmentVariableConfigReference),
  authToken: Schema.optional(McpAuthTokenInput),
  moduleId: Schema.optional(McpModuleIdInput),
  clientName: Schema.optional(McpClientNameInput),
  oauthClientId: Schema.optional(McpOAuthClientIdInput),
  oauthClientSecret: Schema.optional(McpOAuthClientSecretInput),
  headers: Schema.optional(McpHeadersInput),
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
  /** Switching auth type clears discovered tools and sign-ins. */
  authType: Schema.optional(Schema.Literals(["none", "bearer", "oauth"])),
  moduleId: Schema.optional(McpModuleIdInput),
  /** An empty string restores the default client name. */
  clientName: Schema.optional(McpClientNameInput),
  /** An empty string removes the own OAuth app and its secret. */
  oauthClientId: Schema.optional(McpOAuthClientIdInput),
  oauthClientSecret: Schema.optional(McpOAuthClientSecretInput),
  headers: Schema.optional(McpHeadersInput),
  /** `null` removes any auth: a stored token or a secret reference. */
  authReference: Schema.optional(
    Schema.NullOr(EnvironmentVariableConfigReference),
  ),
  /** Sets or rotates the stored token and drops any secret reference. */
  authToken: Schema.optional(McpAuthTokenInput),
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

export const BeginMcpOAuthResponseSchema = successResponse(
  Schema.Struct({ authorizationUrl: Schema.String }),
);

export const SignOutMcpOAuthResponseSchema =
  successResponse(McpServerDataSchema);

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

export const McpServerOAuthFailedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("MCP_SERVER_OAUTH_FAILED"),
    message: Schema.String,
    requestId: Schema.String,
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
  McpServerOAuthFailedResponseSchema,
  McpServersPolicyDeniedResponseSchema,
  McpServersUnavailableResponseSchema,
]);
