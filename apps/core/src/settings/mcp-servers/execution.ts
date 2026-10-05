import { env } from "cloudflare:workers";
import {
  EnvironmentVariableRepository,
  flueMcpServerName,
  McpServerId,
  McpServerRepository,
  type ProjectId,
  type StoredMcpServer,
  type StoredMcpTool,
  ThreadId,
  type UserId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { readMcpServerCredential } from "./credential.js";
import { McpServerRepositoryD1 } from "./repository-d1.js";
import { filterMcpExecutionConnections } from "./service.js";
import {
  createMcpNetworkFetch,
  McpNetworkRejected,
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
  readonly toolDefinitions?: ReadonlyArray<{
    readonly name: string;
    readonly description: string;
    readonly inputSchemaJson: string;
  }>;
  readonly endpoint: string;
  readonly timeoutMs: number;
  readonly authenticated: boolean;
  readonly tools: ReadonlyArray<string>;
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
  const connections = yield* approvedConnections(
    db,
    thread.ownerUserId,
    thread.projectId,
  );
  return connections
    .filter(({ tools }) => tools.length > 0)
    .map(({ server, tools }) => ({
      id: server.id,
      name: flueMcpServerName(server.id),
      displayName: server.name,
      toolDefinitions: tools.map(({ name, description, inputSchemaJson }) => ({
        name,
        description,
        inputSchemaJson,
      })),
      endpoint: server.endpoint,
      timeoutMs: server.timeoutMs,
      authenticated:
        server.authReference !== undefined ||
        server.hasStoredCredential === true,
      tools: tools.map(({ name }) => name),
    })) satisfies ReadonlyArray<McpAgentConnectionData>;
});

interface AuthorizedConnection {
  readonly db: D1Database;
  readonly server: StoredMcpServer;
  readonly tools: ReadonlyArray<StoredMcpTool>;
  readonly credential?: string;
}

const resolveAuthorizedConnection = Effect.fn("resolveAuthorizedMcpConnection")(
  function* (bindings: Bindings, rawThreadId: string, rawServerId: string) {
    const db = yield* decodeD1Binding(bindings.DB).pipe(
      Effect.mapError(() => new McpExecutionUnavailable()),
    );
    const thread = yield* readThread(db, rawThreadId);
    const serverId = yield* Schema.decodeEffect(McpServerId)(rawServerId).pipe(
      Effect.mapError(() => new McpInvocationForbidden()),
    );
    const connections = yield* approvedConnections(
      db,
      thread.ownerUserId,
      thread.projectId,
    );
    const connection = connections.find(({ server }) => server.id === serverId);
    if (connection === undefined || connection.tools.length === 0) {
      return yield* new McpInvocationForbidden();
    }
    if (connection.server.hasStoredCredential === true) {
      const keyring = yield* loadConfigEncryptionKeyring(bindings).pipe(
        Effect.mapError(() => new McpExecutionUnavailable()),
      );
      const credential = yield* Effect.tryPromise({
        try: () => readMcpServerCredential(db, keyring, connection.server),
        catch: () => new McpExecutionUnavailable(),
      });
      // The row vanished between listing and reading: fail closed.
      if (credential === undefined) return yield* new McpInvocationForbidden();
      return { db, ...connection, credential } satisfies AuthorizedConnection;
    }
    if (connection.server.authReference === undefined) {
      return {
        db,
        ...connection,
        credential: undefined,
      } satisfies AuthorizedConnection;
    }
    const authReference = connection.server.authReference;
    const keyring = yield* loadConfigEncryptionKeyring(bindings).pipe(
      Effect.mapError(() => new McpExecutionUnavailable()),
    );
    const variable = yield* Effect.gen(function* () {
      const repository = yield* EnvironmentVariableRepository;
      return yield* repository.find(connection.server.target, authReference.id);
    }).pipe(
      Effect.provide(dependencies(db)),
      Effect.mapError(() => new McpInvocationForbidden()),
    );
    if (variable.kind !== "secret" || !variable.enabled) {
      return yield* new McpInvocationForbidden();
    }
    const credential = yield* decryptEnvironmentVariable(
      keyring,
      {
        id: variable.id,
        target: variable.target,
        name: variable.name,
        kind: variable.kind,
      },
      variable.envelope,
    ).pipe(Effect.mapError(() => new McpExecutionUnavailable()));
    return { db, ...connection, credential } satisfies AuthorizedConnection;
  },
);

export const resolveMcpCredential = async (
  rawThreadId: string,
  rawServerId: string,
): Promise<string> => {
  const connection = await Effect.runPromise(
    resolveAuthorizedConnection(env as Bindings, rawThreadId, rawServerId),
  );
  if (connection.credential === undefined) {
    throw new McpInvocationForbidden();
  }
  return connection.credential;
};

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

const validateToolListing = async (
  connection: AuthorizedConnection,
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
      if (typeof candidate.name !== "string") continue;
      const approved = connection.tools.find(
        ({ name }) => name === candidate.name,
      );
      if (approved === undefined) continue;
      const hash = await mcpToolContractHash({
        name: candidate.name,
        description:
          typeof candidate.description === "string"
            ? candidate.description
            : undefined,
        inputSchema: candidate.inputSchema,
      });
      if (hash !== approved.approvedSchemaHash) {
        throw new McpNetworkRejected({ code: "TOOL_REVIEW_REQUIRED" });
      }
    }
  }
};

export const createAuthorizedMcpFetch =
  (
    rawThreadId: string,
    rawServerId: string,
    expectedEndpoint: string,
    timeoutMs: number,
  ): typeof fetch =>
  async (input, init) => {
    const request = new Request(input, init);
    const connection = await Effect.runPromise(
      resolveAuthorizedConnection(env as Bindings, rawThreadId, rawServerId),
    );
    if (connection.server.endpoint !== expectedEndpoint) {
      throw new McpInvocationForbidden();
    }
    const authorization = request.headers.get("authorization");
    if (
      connection.credential === undefined
        ? authorization !== null
        : authorization !== `Bearer ${connection.credential}`
    ) {
      throw new McpInvocationForbidden();
    }
    const callNames = await toolCallNames(request);
    if (
      callNames.some(
        (callName) => !connection.tools.some(({ name }) => name === callName),
      )
    ) {
      throw new McpInvocationForbidden();
    }
    return createMcpNetworkFetch(
      expectedEndpoint,
      Math.min(timeoutMs, connection.server.timeoutMs),
      {
        validateResponse: async (_outbound, response, body, kind) => {
          if (callNames.length === 0) {
            await validateToolListing(
              connection,
              kind === "sse-event"
                ? new Response(null, {
                    headers: { "content-type": "application/json" },
                  })
                : response,
              body,
            );
          }
        },
      },
    )(request);
  };
