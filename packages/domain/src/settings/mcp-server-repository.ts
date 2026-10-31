import { Context, type Effect, Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { ProjectId } from "../projects/project-id.js";
import type { UserId } from "../users/user-id.js";
import type {
  McpServerId,
  McpServerTarget,
  McpToolName,
  McpToolSchemaHash,
  StoredMcpServer,
  StoredMcpTool,
} from "./mcp-server.js";
import type { WorkspaceId } from "./workspace.js";

export class McpServerNotFound extends Schema.TaggedError<McpServerNotFound>()(
  "McpServerNotFound",
  {},
) {}

export class McpServerLimitExceeded extends Schema.TaggedError<McpServerLimitExceeded>()(
  "McpServerLimitExceeded",
  {},
) {}

export interface McpServerWithTools {
  readonly server: StoredMcpServer;
  readonly tools: ReadonlyArray<StoredMcpTool>;
}

export interface McpExecutionConnection {
  readonly server: StoredMcpServer;
  readonly tools: ReadonlyArray<StoredMcpTool>;
}

type McpRepositoryFailure = PersistenceUnavailable | Schema.SchemaError;

export interface McpServerRepositoryShape {
  readonly list: (
    target: McpServerTarget,
  ) => Effect.Effect<ReadonlyArray<McpServerWithTools>, McpRepositoryFailure>;
  readonly find: (
    target: McpServerTarget,
    id: McpServerId,
  ) => Effect.Effect<
    McpServerWithTools,
    McpRepositoryFailure | McpServerNotFound
  >;
  readonly insert: (
    value: StoredMcpServer,
  ) => Effect.Effect<void, McpRepositoryFailure>;
  readonly replace: (
    value: StoredMcpServer,
  ) => Effect.Effect<void, McpRepositoryFailure | McpServerNotFound>;
  readonly remove: (
    target: McpServerTarget,
    id: McpServerId,
  ) => Effect.Effect<void, McpRepositoryFailure | McpServerNotFound>;
  /**
   * Deletes everything that authenticates to the server: its stored token,
   * secret headers and OAuth client secret, and every person's sign-in.
   */
  readonly clearCredentials: (
    target: McpServerTarget,
    id: McpServerId,
  ) => Effect.Effect<void, McpRepositoryFailure>;
  readonly replaceDiscovery: (
    id: McpServerId,
    tools: ReadonlyArray<StoredMcpTool>,
    /** `approveNew` allows tools not seen before; changed tools still need review. */
    options?: { readonly approveNew?: boolean },
  ) => Effect.Effect<void, McpRepositoryFailure | McpServerNotFound>;
  readonly reviewTool: (
    target: McpServerTarget,
    id: McpServerId,
    name: McpToolName,
    schemaHash: McpToolSchemaHash,
    approved: boolean,
    reviewedAt: StoredMcpTool["discoveredAt"],
    reviewedBy: UserId,
  ) => Effect.Effect<void, McpRepositoryFailure | McpServerNotFound>;
  readonly getWorkspacePolicy: (
    workspaceId: WorkspaceId,
  ) => Effect.Effect<boolean, McpRepositoryFailure>;
  readonly setWorkspacePolicy: (
    workspaceId: WorkspaceId,
    allowPersonal: boolean,
  ) => Effect.Effect<void, McpRepositoryFailure>;
  readonly listForExecution: (
    ownerUserId: UserId,
    projectId: ProjectId,
  ) => Effect.Effect<
    ReadonlyArray<McpExecutionConnection>,
    McpRepositoryFailure
  >;
}

export class McpServerRepository extends Context.Service<
  McpServerRepository,
  McpServerRepositoryShape
>()("@dx/domain/settings/McpServerRepository") {}
