import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { ProjectId } from "../projects/project-id.js";
import { UserId } from "../users/user-id.js";
import { EnvironmentVariableConfigReference } from "./environment-variable.js";
import { WorkspaceId, WorkspaceRole } from "./workspace.js";

export const MAX_MCP_SERVERS_PER_SCOPE = 20;
/** A Thread runs with its owner's personal and workspace servers. */
export const MAX_MCP_SERVERS_PER_THREAD = 2 * MAX_MCP_SERVERS_PER_SCOPE;
export const MAX_MCP_TOOLS_PER_SERVER = 64;
export const MAX_MCP_TOOL_SCHEMA_BYTES = 32_768;
export const MIN_MCP_TIMEOUT_MS = 1_000;
export const MAX_MCP_TIMEOUT_MS = 30_000;

export const McpServerId = Schema.String.check(
  Schema.isPattern(
    /^mcp_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/McpServerId"));

export type McpServerId = typeof McpServerId.Type;

export const McpServerName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
).pipe(Schema.brand("@dx/McpServerName"));

export type McpServerName = typeof McpServerName.Type;

export const McpServerEndpoint = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(2_048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === "https:" &&
        url.username === "" &&
        url.password === "" &&
        (url.port === "" || url.port === "443") &&
        url.hash === ""
      );
    } catch {
      return false;
    }
  }),
).pipe(Schema.brand("@dx/McpServerEndpoint"));

export type McpServerEndpoint = typeof McpServerEndpoint.Type;

export const McpServerTransport = Schema.Literal("streamable-http");

export type McpServerTransport = typeof McpServerTransport.Type;

export const McpServerTimeoutMs = Schema.Int.check(
  Schema.isBetween({
    minimum: MIN_MCP_TIMEOUT_MS,
    maximum: MAX_MCP_TIMEOUT_MS,
  }),
).pipe(Schema.brand("@dx/McpServerTimeoutMs"));

export type McpServerTimeoutMs = typeof McpServerTimeoutMs.Type;

export const McpServerAuthType = Schema.Literals(["none", "bearer", "oauth"]);

export type McpServerAuthType = typeof McpServerAuthType.Type;

/** Sent as the MCP `clientInfo.name` and as the OAuth registration `client_name`. */
export const McpClientName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(80),
).pipe(Schema.brand("@dx/McpClientName"));

export type McpClientName = typeof McpClientName.Type;

export const DEFAULT_MCP_CLIENT_NAME = "dx";

/**
 * The module name Code imports a server's tools under. When a personal and
 * a workspace server share an ID, the workspace server wins.
 */
export const McpModuleId = Schema.String.check(
  Schema.isPattern(/^[a-z0-9][a-z0-9_-]{0,63}$/),
).pipe(Schema.brand("@dx/McpModuleId"));

export type McpModuleId = typeof McpModuleId.Type;

/** A module ID derived from a display name. */
export const mcpModuleIdFor = (name: string): McpModuleId =>
  (name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64)
    .replace(/_+$/g, "") || "mcp") as McpModuleId;

export const MAX_MCP_HEADERS = 16;

export const McpHeaderName = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9!#$%&'*+.^_`|~-]{1,128}$/),
);

/**
 * Header names dx sets itself or that would change the transport; servers
 * cannot be configured to send them.
 */
export const RESERVED_MCP_HEADER_NAMES: ReadonlySet<string> = new Set([
  "accept",
  "accept-encoding",
  "connection",
  "content-length",
  "content-type",
  "cookie",
  "host",
  "last-event-id",
  "mcp-protocol-version",
  "mcp-session-id",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

/** A configured header. Secret values are stored encrypted, never here. */
export const StoredMcpHeader = Schema.Struct({
  name: McpHeaderName,
  secret: Schema.Boolean,
  value: Schema.optional(Schema.String.check(Schema.isMaxLength(4_096))),
});

export type StoredMcpHeader = typeof StoredMcpHeader.Type;

export const McpServerScope = Schema.Literals(["personal", "workspace"]);

export type McpServerScope = typeof McpServerScope.Type;

export const PersonalMcpServerTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  id: UserId,
});

export const WorkspaceMcpServerTarget = Schema.Struct({
  scope: Schema.Literal("workspace"),
  id: WorkspaceId,
});

export const McpServerTarget = Schema.Union([
  PersonalMcpServerTarget,
  WorkspaceMcpServerTarget,
]);

export type McpServerTarget = typeof McpServerTarget.Type;

export const McpHealthStatus = Schema.Literals([
  "unchecked",
  "healthy",
  "unhealthy",
]);

export type McpHealthStatus = typeof McpHealthStatus.Type;

export const McpToolName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/McpToolName"));

export type McpToolName = typeof McpToolName.Type;

export const McpToolSchemaHash = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/McpToolSchemaHash"));

export type McpToolSchemaHash = typeof McpToolSchemaHash.Type;

export const McpToolDescription = Schema.String.check(
  Schema.isMaxLength(4_096),
);

export const McpToolInputSchemaJson = Schema.String.check(
  Schema.isMinLength(2),
  Schema.isMaxLength(MAX_MCP_TOOL_SCHEMA_BYTES),
).pipe(Schema.brand("@dx/McpToolInputSchemaJson"));

export type McpToolInputSchemaJson = typeof McpToolInputSchemaJson.Type;

export const McpServerProjectGrants = Schema.Array(ProjectId).check(
  Schema.isMaxLength(100),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);

export const McpServerRoleGrants = Schema.Array(WorkspaceRole).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(3),
  Schema.makeFilter((values) => new Set(values).size === values.length),
);

export const StoredMcpTool = Schema.Struct({
  name: McpToolName,
  description: McpToolDescription,
  inputSchemaJson: McpToolInputSchemaJson,
  schemaHash: McpToolSchemaHash,
  approvedSchemaHash: Schema.optional(McpToolSchemaHash),
  discoveredAt: Timestamp,
  reviewedAt: Schema.optional(Timestamp),
});

export type StoredMcpTool = typeof StoredMcpTool.Type;

export const StoredMcpServer = Schema.Struct({
  id: McpServerId,
  target: McpServerTarget,
  name: McpServerName,
  endpoint: McpServerEndpoint,
  transport: McpServerTransport,
  authType: McpServerAuthType,
  authReference: Schema.optional(EnvironmentVariableConfigReference),
  /**
   * A bearer token stored on the server itself (mcp_server_credential),
   * exclusive with `authReference` and never part of a sandbox environment.
   */
  hasStoredCredential: Schema.optional(Schema.Boolean),
  clientName: Schema.optional(McpClientName),
  /** An own OAuth app; without it dx registers a client automatically. */
  oauthClientId: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)),
  ),
  hasOAuthClientSecret: Schema.optional(Schema.Boolean),
  headers: Schema.Array(StoredMcpHeader).check(
    Schema.isMaxLength(MAX_MCP_HEADERS),
  ),
  moduleId: Schema.optional(McpModuleId),
  timeoutMs: McpServerTimeoutMs,
  enabled: Schema.Boolean,
  projectIds: McpServerProjectGrants,
  roles: McpServerRoleGrants,
  healthStatus: McpHealthStatus,
  healthCheckedAt: Schema.optional(Timestamp),
  healthErrorCode: Schema.optional(
    Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(64)),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export type StoredMcpServer = typeof StoredMcpServer.Type;

export const normalizeMcpServerName = (value: string): string => value.trim();

export const flueMcpServerName = (id: McpServerId): string =>
  `dx_${id.replace(/[^A-Za-z0-9_-]/g, "_")}`;
