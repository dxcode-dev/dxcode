import {
  EnvironmentVariableRepository,
  MAX_MCP_SERVERS_PER_SCOPE,
  type McpExecutionConnection,
  McpServerId,
  McpServerLimitExceeded,
  McpServerRepository,
  type McpServerTarget,
  type McpToolName,
  type McpToolSchemaHash,
  StoredMcpServer,
  type StoredMcpTool,
  type UserId,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Result, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import {
  discoverMcpTools,
  McpDiscoveryFailed,
  type McpNetworkOptions,
} from "./transport.js";

export class McpAuthReferenceInvalid extends Schema.TaggedError<McpAuthReferenceInvalid>()(
  "McpAuthReferenceInvalid",
  {},
) {}

export const enforcePersonalMcpOverride = Effect.fn(
  "enforcePersonalMcpOverride",
)(function* (target: McpServerTarget, userId: UserId) {
  if (target.scope === "workspace") return;
  const policies = yield* WorkspacePolicyService;
  yield* policies.evaluateForUser(userId, {
    kind: "mcp.use-personal-override",
  });
});

export const filterMcpExecutionConnections = Effect.fn(
  "filterMcpExecutionConnections",
)(function* (
  ownerUserId: UserId,
  connections: ReadonlyArray<McpExecutionConnection>,
) {
  if (!connections.some(({ server }) => server.target.scope === "personal")) {
    return connections;
  }
  const allowPersonal = yield* enforcePersonalMcpOverride(
    { scope: "personal", id: ownerUserId },
    ownerUserId,
  ).pipe(
    Effect.as(true),
    Effect.catchTag("WorkspacePolicyDenied", (denial) =>
      denial.reason === "personal-mcp-overrides-disabled"
        ? Effect.succeed(false)
        : Effect.fail(denial),
    ),
  );
  return allowPersonal
    ? connections
    : connections.filter(({ server }) => server.target.scope !== "personal");
});

interface McpServerServiceShape {
  readonly list: (
    target: McpServerTarget,
  ) => ReturnType<typeof McpServerRepository.Service.list>;
  readonly create: (
    target: McpServerTarget,
    input: Omit<
      StoredMcpServer,
      | "id"
      | "target"
      | "transport"
      | "enabled"
      | "healthStatus"
      | "createdAt"
      | "updatedAt"
    >,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<StoredMcpServer, unknown>;
  readonly update: (
    target: McpServerTarget,
    id: McpServerId,
    input: Partial<
      Pick<
        StoredMcpServer,
        | "name"
        | "endpoint"
        | "authReference"
        | "timeoutMs"
        | "enabled"
        | "projectIds"
        | "roles"
      >
    > & {
      readonly clearAuthReference?: boolean;
      /**
       * The caller switched between no auth, a stored token, and a secret
       * reference. Like an endpoint change, it clears discovery and approvals;
       * rotating a stored token does not.
       */
      readonly authModeChanged?: boolean;
    },
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<StoredMcpServer, unknown>;
  readonly discover: (
    target: McpServerTarget,
    id: McpServerId,
    credential: string | undefined,
    audit: { readonly userId: UserId; readonly requestId: string },
    networkOptions?: McpNetworkOptions,
  ) => Effect.Effect<
    {
      readonly server: StoredMcpServer;
      readonly tools: ReadonlyArray<StoredMcpTool>;
    },
    unknown
  >;
  readonly reviewTool: (
    target: McpServerTarget,
    id: McpServerId,
    name: McpToolName,
    schemaHash: McpToolSchemaHash,
    approved: boolean,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<void, unknown>;
  readonly remove: (
    target: McpServerTarget,
    id: McpServerId,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<void, unknown>;
  readonly getWorkspacePolicy: typeof McpServerRepository.Service.getWorkspacePolicy;
  readonly setWorkspacePolicy: (
    workspaceId: Parameters<
      typeof McpServerRepository.Service.setWorkspacePolicy
    >[0],
    allowPersonal: boolean,
    audit: { readonly userId: UserId; readonly requestId: string },
  ) => Effect.Effect<void, unknown>;
}

export class McpServerService extends Context.Service<
  McpServerService,
  McpServerServiceShape
>()("@dx/core/settings/mcp-servers/McpServerService") {
  static readonly layer = Layer.effect(
    McpServerService,
    Effect.gen(function* () {
      const repository = yield* McpServerRepository;
      const environment = yield* EnvironmentVariableRepository;
      const settingsAudit = yield* SettingsAudit;

      const audit = (
        action: string,
        target: McpServerTarget,
        context: { readonly userId: UserId; readonly requestId: string },
        metadata: {
          readonly id?: McpServerId;
          readonly tool?: string;
        } = {},
      ) =>
        settingsAudit.record({
          action,
          scope: target.scope,
          outcome: "success",
          requestId: context.requestId,
          userId: context.userId,
          ...(metadata.id === undefined ? {} : { mcpServerId: metadata.id }),
          ...(metadata.tool === undefined
            ? {}
            : { mcpToolName: metadata.tool }),
        });

      const validateAuth = Effect.fn("McpServerService.validateAuth")(
        function* (
          target: McpServerTarget,
          reference: StoredMcpServer["authReference"],
        ) {
          if (reference === undefined) return;
          const value = yield* environment
            .find(target, reference.id)
            .pipe(
              Effect.catchTag("EnvironmentVariableNotFound", () =>
                Effect.fail(new McpAuthReferenceInvalid()),
              ),
            );
          if (value.kind !== "secret" || !value.enabled) {
            return yield* new McpAuthReferenceInvalid();
          }
        },
      );

      return McpServerService.of({
        list: repository.list,
        create: Effect.fn("McpServerService.create")(
          function* (target, input, auditContext) {
            const existing = yield* repository.list(target);
            if (existing.length >= MAX_MCP_SERVERS_PER_SCOPE) {
              return yield* new McpServerLimitExceeded();
            }
            yield* validateAuth(target, input.authReference);
            const now = yield* DateTime.now;
            const id = yield* Schema.decodeEffect(McpServerId)(
              `mcp_${crypto.randomUUID()}`,
            );
            const server = yield* Schema.decodeEffect(
              Schema.toType(StoredMcpServer),
            )({
              ...input,
              id,
              target,
              transport: "streamable-http",
              enabled: true,
              healthStatus: "unchecked",
              createdAt: now,
              updatedAt: now,
            });
            yield* repository.insert(server);
            yield* audit("mcp_server.create", target, auditContext, {
              id: server.id,
            });
            return server;
          },
        ),
        update: Effect.fn("McpServerService.update")(
          function* (target, id, input, auditContext) {
            const current = (yield* repository.find(target, id)).server;
            const authReference = input.clearAuthReference
              ? undefined
              : (input.authReference ?? current.authReference);
            yield* validateAuth(target, authReference);
            const updatedAt = yield* DateTime.now;
            const connectionChanged =
              (input.endpoint !== undefined &&
                input.endpoint !== current.endpoint) ||
              input.clearAuthReference === true ||
              input.authModeChanged === true ||
              (input.authReference !== undefined &&
                input.authReference.id !== current.authReference?.id);
            const server = yield* Schema.decodeEffect(
              Schema.toType(StoredMcpServer),
            )({
              ...current,
              ...input,
              authReference,
              ...(connectionChanged
                ? {
                    healthStatus: "unchecked",
                    healthCheckedAt: undefined,
                    healthErrorCode: undefined,
                  }
                : {}),
              updatedAt,
            });
            // Clear approvals before making a new trust boundary visible. If
            // the subsequent update fails, the old connection remains usable
            // only after another explicit discovery and review.
            if (connectionChanged) yield* repository.replaceDiscovery(id, []);
            yield* repository.replace(server);
            yield* audit("mcp_server.update", target, auditContext, { id });
            return server;
          },
        ),
        discover: Effect.fn("McpServerService.discover")(
          function* (target, id, credential, auditContext, networkOptions) {
            const current = (yield* repository.find(target, id)).server;
            const result = yield* Effect.result(
              discoverMcpTools(current, credential, networkOptions),
            );
            const checkedAt = yield* DateTime.now;
            if (Result.isFailure(result)) {
              const failed = yield* Schema.decodeEffect(
                Schema.toType(StoredMcpServer),
              )({
                ...current,
                healthStatus: "unhealthy",
                healthCheckedAt: checkedAt,
                healthErrorCode:
                  result.failure instanceof McpDiscoveryFailed
                    ? result.failure.code
                    : "DISCOVERY_FAILED",
                updatedAt: checkedAt,
              });
              yield* repository.replace(failed);
              return yield* result.failure;
            }
            yield* repository.replaceDiscovery(id, result.success);
            const healthy = yield* Schema.decodeEffect(
              Schema.toType(StoredMcpServer),
            )({
              ...current,
              healthStatus: "healthy",
              healthCheckedAt: checkedAt,
              healthErrorCode: undefined,
              updatedAt: checkedAt,
            });
            yield* repository.replace(healthy);
            yield* audit("mcp_server.discover", target, auditContext, { id });
            return yield* repository.find(target, id);
          },
        ),
        reviewTool: Effect.fn("McpServerService.reviewTool")(
          function* (target, id, name, schemaHash, approved, auditContext) {
            const reviewedAt = yield* DateTime.now;
            yield* repository.reviewTool(
              target,
              id,
              name,
              schemaHash,
              approved,
              reviewedAt,
              auditContext.userId,
            );
            yield* audit(
              approved ? "mcp_tool.approve" : "mcp_tool.revoke",
              target,
              auditContext,
              { id, tool: name },
            );
          },
        ),
        remove: Effect.fn("McpServerService.remove")(
          function* (target, id, auditContext) {
            yield* repository.remove(target, id);
            yield* audit("mcp_server.delete", target, auditContext, { id });
          },
        ),
        getWorkspacePolicy: repository.getWorkspacePolicy,
        setWorkspacePolicy: Effect.fn("McpServerService.setWorkspacePolicy")(
          function* (workspaceId, allowPersonal, auditContext) {
            yield* repository.setWorkspacePolicy(workspaceId, allowPersonal);
            yield* settingsAudit.record({
              action: "mcp_workspace_policy.update",
              scope: "workspace",
              outcome: "success",
              requestId: auditContext.requestId,
              userId: auditContext.userId,
              workspaceId,
            });
          },
        ),
      });
    }),
  );
}
