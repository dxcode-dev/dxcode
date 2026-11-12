import {
  EnvironmentVariableRepository,
  flueMcpServerName,
  McpServerId,
  McpServerRepository,
  type ProjectId,
  type StoredMcpServer,
  type StoredMcpTool,
  ThreadId,
  Timestamp,
  type UserId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { readRepositoryMcpConnection } from "../../plugins/repository/repository-mcp.js";
import { SettingsAudit } from "../audit.js";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import {
  decodeOwnerPolicy,
  ownerPolicyStatements,
  WorkspacePolicyRepositoryD1,
} from "../workspace-policy/repository-d1.js";
import {
  WorkspacePolicyService,
  workspacePolicyDenial,
} from "../workspace-policy/service.js";
import { readMcpServerCredential } from "./credential.js";
import type { LocalMcpServerData } from "./local-servers.js";
import { mcpOAuthAccessToken } from "./oauth.js";
import {
  decodeThreadExecutionServer,
  McpServerRepositoryD1,
  threadExecutionServerStatements,
} from "./repository-d1.js";
import { mcpHeaderSecretName, readMcpServerSecrets } from "./secrets.js";
import {
  effectiveMcpModuleId,
  filterMcpExecutionConnections,
} from "./service.js";
import {
  createMcpNetworkFetch,
  McpNetworkRejected,
  mcpStoredTool,
  mcpToolContractHash,
} from "./transport.js";

const ExecutionThreadRow = Schema.Struct({
  project_id: Schema.String,
  owner_user_id: Schema.String,
});

export class McpInvocationForbidden extends Schema.TaggedError<McpInvocationForbidden>()(
  "McpInvocationForbidden",
  {},
) {}

export class McpExecutionUnavailable extends Schema.TaggedError<McpExecutionUnavailable>()(
  "McpExecutionUnavailable",
  {},
) {}

export interface McpAgentConnectionData {
  readonly id: string;
  readonly name: string;
  readonly displayName?: string;
  /** The module Code imports this server's tools from. */
  readonly moduleId?: string;
  /** Sent as the MCP `clientInfo.name`. */
  readonly clientName?: string;
  readonly toolDefinitions?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchemaJson: string;
  }>;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly authenticated: boolean;
  readonly tools: ReadonlyArray<string>;
  /**
   * A plugin's local (stdio) server, which dxd runs in the Thread's Orb.
   * Its tools are listed from the running server, not stored.
   */
  readonly local?: LocalMcpServerData;
}

const dependencies = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  return Layer.merge(
    McpServerRepositoryD1(db),
    EnvironmentVariableRepositoryD1(db),
  ).pipe(Layer.provide(d1));
};

const policyDependencies = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  return WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
};

const readThread = Effect.fn("mcpExecutionReadThread")(function* (
  db: D1Database,
  rawThreadId: string,
) {
  const threadId = yield* Schema.decodeEffect(ThreadId)(rawThreadId).pipe(
    Effect.mapError(() => new McpInvocationForbidden()),
  );
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          "SELECT project_id, owner_user_id FROM threads WHERE id = ? LIMIT 1",
        )
        .bind(threadId)
        .first(),
    catch: () => new McpExecutionUnavailable(),
  });
  if (row === null) return yield* new McpInvocationForbidden();
  const decoded = yield* Schema.decodeUnknownEffect(ExecutionThreadRow)(
    row,
  ).pipe(Effect.mapError(() => new McpExecutionUnavailable()));
  return {
    id: threadId,
    projectId: decoded.project_id as ProjectId,
    ownerUserId: decoded.owner_user_id as UserId,
  };
});

const approvedConnections = Effect.fn("mcpApprovedConnections")(function* (
  db: D1Database,
  ownerUserId: UserId,
  projectId: ProjectId,
) {
  return yield* Effect.gen(function* () {
    const repository = yield* McpServerRepository;
    const connections = yield* repository.listForExecution(
      ownerUserId,
      projectId,
    );
    return yield* filterMcpExecutionConnections(ownerUserId, connections);
  }).pipe(
    Effect.provide(Layer.merge(dependencies(db), policyDependencies(db))),
    Effect.mapError(() => new McpExecutionUnavailable()),
  );
});

export const resolveMcpAgentConnections = Effect.fn(
  "resolveMcpAgentConnections",
)(function* (binding: unknown, rawThreadId: string) {
  const db = yield* decodeD1Binding(binding).pipe(
    Effect.mapError(() => new McpExecutionUnavailable()),
  );
  const thread = yield* readThread(db, rawThreadId);
  return yield* resolveMcpAgentConnectionsFor(
    binding,
    thread.ownerUserId,
    thread.projectId,
  );
});

/** The same connections for a Thread that is not persisted yet. */
export const resolveMcpAgentConnectionsFor = Effect.fn(
  "resolveMcpAgentConnectionsFor",
)(function* (binding: unknown, ownerUserId: UserId, projectId: ProjectId) {
  const db = yield* decodeD1Binding(binding).pipe(
    Effect.mapError(() => new McpExecutionUnavailable()),
  );
  const connections = yield* approvedConnections(db, ownerUserId, projectId);
  const usable = connections.filter(({ tools }) => tools.length > 0);
  // A workspace server overrides a personal server with the same module ID.
  const workspaceModules = new Set(
    usable
      .filter(({ server }) => server.target.scope === "workspace")
      .map(({ server }) => effectiveMcpModuleId(server)),
  );
  return usable
    .filter(
      ({ server }) =>
        server.target.scope === "workspace" ||
        !workspaceModules.has(effectiveMcpModuleId(server)),
    )
    .map(({ server, tools }) => ({
      id: server.id,
      name: flueMcpServerName(server.id),
      displayName: server.name,
      moduleId: effectiveMcpModuleId(server),
      ...(server.clientName === undefined
        ? {}
        : { clientName: server.clientName }),
      toolDefinitions: tools.map(({ name, description, inputSchemaJson }) => ({
        name,
        description,
        inputSchemaJson,
      })),
      endpoint: server.endpoint,
      timeoutMs: server.timeoutMs,
      authenticated: server.authType !== "none",
      tools: tools.map(({ name }) => name),
    })) satisfies ReadonlyArray<McpAgentConnectionData>;
});

interface AuthorizedConnection {
  readonly db: D1Database;
  readonly server: StoredMcpServer;
  readonly tools: ReadonlyArray<StoredMcpTool>;
  readonly credential?: string;
  /** Configured headers with secret values decrypted. */
  readonly headers: Readonly<Record<string, string>>;
}

/**
 * The server's configured headers with secret values decrypted. A secret
 * header whose value is missing fails closed.
 */
export const resolveMcpHeaders = async (
  db: D1Database,
  keyring: ConfigEncryptionKeyring | undefined,
  server: StoredMcpServer,
): Promise<Readonly<Record<string, string>>> => {
  if (server.headers.length === 0) return {};
  const secrets =
    keyring === undefined || !server.headers.some(({ secret }) => secret)
      ? new Map<string, string>()
      : await readMcpServerSecrets(db, keyring, server);
  return Object.fromEntries(
    server.headers.map(({ name, secret, value }) => {
      const resolved = secret
        ? secrets.get(mcpHeaderSecretName(name))
        : (value ?? "");
      if (resolved === undefined) throw new McpInvocationForbidden();
      return [name, resolved];
    }),
  );
};

/**
 * The server a Thread may call, read in one D1 round trip: the Thread, the
 * server with its allowed tools under the same grants as
 * `listForExecution`, and the owner's workspace policy for personal servers.
 */
const readExecutionServer = Effect.fn("mcpReadExecutionServer")(function* (
  db: D1Database,
  threadId: ThreadId,
  serverId: McpServerId,
) {
  const [thread, servers, tools, membership, policy] = yield* Effect.tryPromise(
    {
      try: () =>
        db.batch([
          db
            .prepare(
              "SELECT project_id, owner_user_id FROM threads WHERE id = ?1 LIMIT 1",
            )
            .bind(threadId),
          ...threadExecutionServerStatements(db, threadId, serverId),
          ...ownerPolicyStatements(
            db,
            "(SELECT owner_user_id FROM threads WHERE id = ?1)",
            [threadId],
          ),
        ]),
      catch: () => new McpExecutionUnavailable(),
    },
  );
  if (
    thread === undefined ||
    servers === undefined ||
    tools === undefined ||
    membership === undefined ||
    policy === undefined
  )
    return yield* new McpExecutionUnavailable();
  const threadRow = thread.results[0];
  if (threadRow === undefined) return yield* new McpInvocationForbidden();
  const owner = yield* Schema.decodeUnknownEffect(ExecutionThreadRow)(
    threadRow,
  ).pipe(Effect.mapError(() => new McpExecutionUnavailable()));
  const connection = yield* decodeThreadExecutionServer(servers, tools).pipe(
    Effect.mapError(() => new McpExecutionUnavailable()),
  );
  if (connection === undefined || connection.tools.length === 0)
    return yield* new McpInvocationForbidden();
  if (connection.server.target.scope === "personal") {
    // As filterMcpExecutionConnections: a workspace may keep its members to
    // workspace servers.
    const workspace = yield* Effect.tryPromise({
      try: () => decodeOwnerPolicy(membership, policy, { requirePolicy: true }),
      catch: () => new McpExecutionUnavailable(),
    });
    if (
      workspace.policy !== undefined &&
      workspacePolicyDenial(workspace.policy, {
        kind: "mcp.use-personal-override",
      }) !== undefined
    )
      return yield* new McpInvocationForbidden();
  }
  return { ownerUserId: owner.owner_user_id as UserId, ...connection };
});

const resolveAuthorizedConnection = Effect.fn("resolveAuthorizedMcpConnection")(
  function* (bindings: Bindings, rawThreadId: string, rawServerId: string) {
    const db = yield* decodeD1Binding(bindings.DB).pipe(
      Effect.mapError(() => new McpExecutionUnavailable()),
    );
    const threadId = yield* Schema.decodeEffect(ThreadId)(rawThreadId).pipe(
      Effect.mapError(() => new McpInvocationForbidden()),
    );
    const serverId = yield* Schema.decodeEffect(McpServerId)(rawServerId).pipe(
      Effect.mapError(() => new McpInvocationForbidden()),
    );
    const { ownerUserId, ...connection } = yield* readExecutionServer(
      db,
      threadId,
      serverId,
    );
    const server = connection.server;
    const keyring =
      server.authType === "none" && !server.headers.some(({ secret }) => secret)
        ? undefined
        : yield* loadConfigEncryptionKeyring(bindings).pipe(
            Effect.mapError(() => new McpExecutionUnavailable()),
          );
    const headers = yield* Effect.tryPromise({
      try: () => resolveMcpHeaders(db, keyring, server),
      catch: (cause) =>
        cause instanceof McpInvocationForbidden
          ? cause
          : new McpExecutionUnavailable(),
    });
    const credential = yield* resolveExecutionCredential(
      db,
      keyring,
      server,
      ownerUserId,
    );
    return {
      db,
      ...connection,
      credential,
      headers,
    } satisfies AuthorizedConnection;
  },
);

/** The credential a Thread owner's calls carry, by the server's auth type. */
const resolveExecutionCredential = Effect.fn("resolveMcpExecutionCredential")(
  function* (
    db: D1Database,
    keyring: ConfigEncryptionKeyring | undefined,
    server: StoredMcpServer,
    ownerUserId: UserId,
  ) {
    if (server.authType === "none" || keyring === undefined) return undefined;
    if (server.authType === "oauth") {
      const token = yield* Effect.tryPromise({
        try: () => mcpOAuthAccessToken(db, keyring, server, ownerUserId),
        // A refresh the server refused needs the person to sign in again.
        catch: () => new McpInvocationForbidden(),
      });
      if (token === undefined) return yield* new McpInvocationForbidden();
      return token;
    }
    if (server.hasStoredCredential === true) {
      const credential = yield* Effect.tryPromise({
        try: () => readMcpServerCredential(db, keyring, server),
        catch: () => new McpExecutionUnavailable(),
      });
      // The row vanished between listing and reading: fail closed.
      if (credential === undefined) return yield* new McpInvocationForbidden();
      return credential;
    }
    const authReference = server.authReference;
    if (authReference === undefined) return yield* new McpInvocationForbidden();
    const variable = yield* Effect.gen(function* () {
      const repository = yield* EnvironmentVariableRepository;
      return yield* repository.find(server.target, authReference.id);
    }).pipe(
      Effect.provide(dependencies(db)),
      Effect.mapError(() => new McpInvocationForbidden()),
    );
    if (variable.kind !== "secret" || !variable.enabled) {
      return yield* new McpInvocationForbidden();
    }
    return yield* decryptEnvironmentVariable(
      keyring,
      {
        id: variable.id,
        target: variable.target,
        name: variable.name,
        kind: variable.kind,
      },
      variable.envelope,
    ).pipe(Effect.mapError(() => new McpExecutionUnavailable()));
  },
);

interface JsonRpcMessage {
  readonly method?: unknown;
  readonly params?: unknown;
  readonly result?: unknown;
}

const parseMessages = (
  body: Uint8Array,
  contentType: string | null,
): ReadonlyArray<JsonRpcMessage> => {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
  const values = contentType?.includes("text/event-stream")
    ? text
        .split(/\r?\n/)
        .filter((line) => line.startsWith("data:"))
        .map((line) => JSON.parse(line.slice(5).trim()) as unknown)
    : [JSON.parse(text) as unknown];
  return values.flatMap((value) =>
    Array.isArray(value)
      ? value.filter(
          (item): item is JsonRpcMessage =>
            typeof item === "object" && item !== null,
        )
      : typeof value === "object" && value !== null
        ? [value as JsonRpcMessage]
        : [],
  );
};

const toolCallNames = async (
  request: Request,
): Promise<ReadonlyArray<string>> => {
  if (request.method === "GET" || request.body === null) return [];
  try {
    const messages = parseMessages(
      new Uint8Array(await request.clone().arrayBuffer()),
      request.headers.get("content-type"),
    );
    const names: Array<string> = [];
    for (const call of messages.filter(
      ({ method }) => method === "tools/call",
    )) {
      if (typeof call.params !== "object" || call.params === null) {
        throw new McpInvocationForbidden();
      }
      const name = (call.params as { readonly name?: unknown }).name;
      if (typeof name !== "string") throw new McpInvocationForbidden();
      names.push(name);
    }
    return names;
  } catch {
    throw new McpInvocationForbidden();
  }
};

/**
 * Stores the contract a server now lists for an allowed tool, so the tool
 * shows for review in Settings and leaves its Threads until someone allows
 * it again, as a refresh would. Best effort: the call fails either way.
 */
const recordChangedTool = async (
  connection: AuthorizedConnection,
  tool: {
    readonly name: string;
    readonly description?: string;
    readonly inputSchema: unknown;
  },
) => {
  const stored = await Effect.runPromise(
    DateTime.now.pipe(
      Effect.flatMap((now) => mcpStoredTool(tool as never, now)),
      Effect.option,
    ),
  );
  if (Option.isNone(stored)) return;
  await connection.db
    .prepare(
      `UPDATE mcp_tool
          SET description = ?, input_schema_json = ?, schema_hash = ?,
              discovered_at = ?
        WHERE server_id = ? AND name = ? AND approved_schema_hash IS NOT NULL`,
    )
    .bind(
      stored.value.description,
      stored.value.inputSchemaJson,
      stored.value.schemaHash,
      Schema.encodeSync(Timestamp)(stored.value.discoveredAt),
      connection.server.id,
      stored.value.name,
    )
    .run()
    .catch(() => undefined);
};

/**
 * Checks the listed contract of the one tool this connection calls against
 * the contract that was allowed. Another tool's change does not block it; that
 * tool is checked when something calls it.
 */
const validateToolListing = async (
  connection: AuthorizedConnection,
  toolName: string,
  response: Response,
  body: Uint8Array,
) => {
  // Servers acknowledge client notifications with an empty body (202).
  if (body.byteLength === 0) return;
  let messages: ReadonlyArray<JsonRpcMessage>;
  try {
    messages = parseMessages(body, response.headers.get("content-type"));
  } catch {
    throw new McpNetworkRejected({ code: "INVALID_MCP_RESPONSE" });
  }
  for (const message of messages) {
    if (typeof message.result !== "object" || message.result === null) continue;
    const tools = (message.result as { readonly tools?: unknown }).tools;
    if (!Array.isArray(tools)) continue;
    for (const value of tools) {
      if (typeof value !== "object" || value === null) continue;
      const candidate = value as {
        readonly name?: unknown;
        readonly description?: unknown;
        readonly inputSchema?: unknown;
      };
      if (candidate.name !== toolName) continue;
      const approved = connection.tools.find(({ name }) => name === toolName);
      if (approved === undefined) continue;
      const listed = {
        name: toolName,
        description:
          typeof candidate.description === "string"
            ? candidate.description
            : undefined,
        inputSchema: candidate.inputSchema,
      };
      if ((await mcpToolContractHash(listed)) !== approved.approvedSchemaHash) {
        await recordChangedTool(connection, listed);
        throw new McpNetworkRejected({ code: "TOOL_REVIEW_REQUIRED" });
      }
    }
  }
};

/** One Code MCP call's connection, resolved once for all its requests. */
export interface AuthorizedMcpCall {
  /** The bearer token or OAuth access token, when the server uses one. */
  readonly credential: string | undefined;
  /** The fetch the call's MCP client sends every request through. */
  readonly fetch: typeof fetch;
}

/**
 * Authorizes one Code call of `toolName` against current settings: the
 * Thread's owner may use the server in its Project, the tool is allowed, and
 * the server still has `expectedEndpoint`. The connection (credential and
 * configured headers) is resolved once, in one D1 round trip, and serves
 * every request of this call; the next call resolves it again, so removing
 * the server, revoking a review or sign-in, or changing a key stops it.
 * Every request still carries only this connection's credential, sends
 * `tools/call` only for allowed tools, and goes only to `expectedEndpoint`,
 * and a tool listing must show `toolName` with its allowed contract.
 */
export const authorizeMcpCall = async (
  bindings: Bindings,
  rawThreadId: string,
  rawServerId: string,
  expectedEndpoint: string,
  timeoutMs: number,
  toolName: string,
): Promise<AuthorizedMcpCall> => {
  const connection: AuthorizedConnection = await Effect.runPromise(
    resolveAuthorizedConnection(bindings, rawThreadId, rawServerId),
  ).catch(async (error: unknown) => {
    // Not one of the owner's servers: maybe one a repository plugin
    // declared, as this Thread's latest submission recorded it
    // (plugins/repository/repository-mcp.ts). Owner servers keep their one
    // D1 round trip.
    if (!(error instanceof McpInvocationForbidden) || bindings.DB === undefined)
      throw error;
    const repository = await readRepositoryMcpConnection(
      bindings.DB,
      rawThreadId,
      rawServerId,
    );
    if (repository === undefined) throw error;
    return repository;
  });
  if (connection.server.endpoint !== expectedEndpoint) {
    throw new McpInvocationForbidden();
  }
  const requestTimeoutMs = Math.min(timeoutMs, connection.server.timeoutMs);
  return {
    credential: connection.credential,
    fetch: async (input, init) => {
      const request = new Request(input, init);
      const authorization = request.headers.get("authorization");
      if (
        connection.credential === undefined
          ? authorization !== null
          : authorization !== `Bearer ${connection.credential}`
      ) {
        throw new McpInvocationForbidden();
      }
      // Core adds the configured headers itself; the caller never sees
      // secret header values and cannot replace them.
      const outbound = new Headers(request.headers);
      for (const [name, value] of Object.entries(connection.headers))
        outbound.set(name, value);
      const callNames = await toolCallNames(request);
      if (
        callNames.some(
          (callName) => !connection.tools.some(({ name }) => name === callName),
        )
      ) {
        throw new McpInvocationForbidden();
      }
      return createMcpNetworkFetch(expectedEndpoint, requestTimeoutMs, {
        validateResponse: async (_outbound, response, body, kind) => {
          if (callNames.length === 0) {
            await validateToolListing(
              connection,
              toolName,
              kind === "sse-event"
                ? new Response(null, {
                    headers: { "content-type": "application/json" },
                  })
                : response,
              body,
            );
          }
        },
      })(new Request(request, { headers: outbound }));
    },
  };
};
