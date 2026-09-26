import { env } from "cloudflare:workers";
import {
  EnvironmentVariableNotFound,
  EnvironmentVariableRepository,
  McpServerNotFound,
  McpServerRepository,
  PluginId,
  type PluginLifecycleEvent,
  PluginManifest,
  PluginRepository,
  type PluginTarget,
  type PluginToolName,
  PluginVersion,
  type StoredPluginVersion,
  type Thread,
  ThreadId,
  WorkspacePolicyDenied,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import type { Sandbox as FlueSandbox } from "@flue/runtime";
import { getLogger } from "@logtape/logtape";
import { Sandbox as E2BSandbox, type SandboxOpts } from "e2b";
import {
  Context,
  DateTime,
  Effect,
  Layer,
  Option,
  Redacted,
  Result,
  Schema,
} from "effect";
import { loadE2BRequirements } from "../../execution/e2b/requirements.js";
import type { Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { McpServerRepositoryD1 } from "../mcp-servers/repository-d1.js";
import { SettingsService } from "../service.js";
import {
  loadAuthorizedTriggerDelivery,
  TriggerDeliveryForbidden,
} from "../triggers/authorization.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { previewPluginImport } from "./import.js";
import { PluginRepositoryD1 } from "./repository-d1.js";

export const PLUGIN_WALL_TIME_LIMIT_MS = 10_000;
export const PLUGIN_CPU_TIME_LIMIT_SECONDS = 5;
export const PLUGIN_INPUT_LIMIT_BYTES = 65_536;
export const PLUGIN_OUTPUT_LIMIT_BYTES = 65_536;
export const PLUGIN_PROCESS_LIMIT = 32;
export const PLUGIN_MEMORY_LIMIT_KIB = 262_144;
export const PLUGIN_PROJECT_FILE_LIMIT = 128;
export const PLUGIN_PROJECT_BYTES_LIMIT = 1_048_576;
export const PLUGIN_PROJECT_FILE_BYTES_LIMIT = 65_536;

const logger = getLogger(["dx", "settings", "plugins", "execution"]);

const attachCause = <E extends object>(error: E, cause: unknown): E => {
  Object.defineProperty(error, "cause", {
    configurable: false,
    enumerable: false,
    value: cause,
    writable: false,
  });
  return error;
};

export class PluginExecutionForbidden extends Schema.TaggedError<PluginExecutionForbidden>()(
  "PluginExecutionForbidden",
  { operation: Schema.String },
) {
  declare readonly cause?: unknown;

  static new(
    props: { readonly operation: string },
    cause: unknown,
  ): PluginExecutionForbidden {
    return attachCause(new this(props), cause);
  }
}

export class PluginExecutionUnavailable extends Schema.TaggedError<PluginExecutionUnavailable>()(
  "PluginExecutionUnavailable",
  { operation: Schema.String },
) {
  declare readonly cause?: unknown;

  static new(
    props: { readonly operation: string },
    cause: unknown,
  ): PluginExecutionUnavailable {
    return attachCause(new this(props), cause);
  }
}

export class PluginExecutionLimited extends Schema.TaggedError<PluginExecutionLimited>()(
  "PluginExecutionLimited",
  {},
) {}

type PluginExecutionError =
  | PluginExecutionForbidden
  | PluginExecutionUnavailable
  | PluginExecutionLimited;

const isPluginExecutionError = (
  failure: unknown,
): failure is PluginExecutionError =>
  failure instanceof PluginExecutionForbidden ||
  failure instanceof PluginExecutionUnavailable ||
  failure instanceof PluginExecutionLimited;

const unavailable =
  (operation: string, logCause = true) =>
  (cause: unknown = undefined): PluginExecutionUnavailable => {
    logger.warn("Plugin execution unavailable.", {
      event: "plugin_execution_unavailable",
      operation,
      ...(logCause ? { cause } : {}),
    });
    return PluginExecutionUnavailable.new({ operation }, cause);
  };

const forbidden =
  (operation: string) =>
  (cause: unknown = undefined): PluginExecutionForbidden => {
    logger.warn("Plugin execution forbidden.", {
      event: "plugin_execution_forbidden",
      operation,
      cause,
    });
    return PluginExecutionForbidden.new({ operation }, cause);
  };

const triggerAuthorizationExecutionError = (failure: unknown) =>
  failure instanceof TriggerDeliveryForbidden
    ? forbidden("trigger.authorize")(failure)
    : unavailable("trigger.authorize")(failure);

export interface PluginProjectFile {
  readonly path: string;
  readonly content: Uint8Array;
}

export interface PluginIsolationInput {
  readonly environment: string;
  readonly pluginId: string;
  readonly version: string;
  readonly invocationId: string;
  readonly entrypoint: string;
  readonly sourceFiles: ReadonlyArray<{
    readonly path: string;
    readonly content: string;
  }>;
  readonly projectFiles: ReadonlyArray<PluginProjectFile>;
  readonly networkDestinations: ReadonlyArray<string>;
  readonly secrets: Readonly<Record<string, string>>;
  readonly invocation: {
    readonly kind: "tool" | "lifecycle" | "trigger";
    readonly name: string;
    readonly input: unknown;
    readonly context: Readonly<Record<string, unknown>>;
  };
}

export interface PluginIsolationOutput {
  readonly result: unknown;
  readonly truncated: boolean;
}

export interface PluginIsolationShape {
  readonly invoke: (
    input: PluginIsolationInput,
  ) => Effect.Effect<
    PluginIsolationOutput,
    PluginExecutionUnavailable | PluginExecutionLimited
  >;
}

export class PluginIsolation extends Context.Service<
  PluginIsolation,
  PluginIsolationShape
>()("@dx/core/settings/plugins/PluginIsolation") {}

export interface E2BPluginApi {
  create(options: SandboxOpts): Promise<E2BSandbox>;
}

const liveE2BPluginApi: E2BPluginApi = {
  create: (options) => E2BSandbox.create(options),
};

const runnerSource = `
import { readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

const invocation = JSON.parse(readFileSync("/runtime/invocation.json", "utf8"));
const plugin = await import(pathToFileURL("/plugin/" + invocation.entrypoint).href);
const registry = invocation.kind === "tool"
  ? plugin.tools
  : invocation.kind === "lifecycle"
    ? plugin.lifecycle
    : plugin.triggers;
const run = registry?.[invocation.name];
if (typeof run !== "function") throw new Error("Capability is not exported.");
const value = await run({ input: invocation.input, context: invocation.context });
const serialized = JSON.stringify(value ?? null);
const bytes = new TextEncoder().encode(serialized);
const output = bytes.byteLength <= ${PLUGIN_OUTPUT_LIMIT_BYTES}
  ? { result: JSON.parse(serialized), truncated: false }
  : { result: new TextDecoder().decode(bytes.slice(0, ${PLUGIN_OUTPUT_LIMIT_BYTES})), truncated: true };
writeFileSync("/runtime/result.json", JSON.stringify(output));
`;

const bytesBuffer = (bytes: Uint8Array): ArrayBuffer =>
  bytes.buffer.slice(
    bytes.byteOffset,
    bytes.byteOffset + bytes.byteLength,
  ) as ArrayBuffer;

export const makePluginIsolation = (
  api: E2BPluginApi,
  requirements: {
    readonly apiKey: string;
  },
): PluginIsolationShape => ({
  invoke: Effect.fn("PluginIsolation.invoke")(function* (input) {
    const serializedInvocation = yield* Effect.try({
      try: () =>
        JSON.stringify({
          ...input.invocation,
          entrypoint: input.entrypoint,
        }),
      catch: () => new PluginExecutionLimited(),
    });
    if (
      new TextEncoder().encode(serializedInvocation).byteLength >
      PLUGIN_INPUT_LIMIT_BYTES
    ) {
      return yield* new PluginExecutionLimited();
    }
    return yield* Effect.acquireUseRelease(
      Effect.tryPromise({
        try: () =>
          api.create({
            apiKey: requirements.apiKey,
            template: "base",
            timeoutMs: 30_000,
            requestTimeoutMs: 30_000,
            envs: {},
            metadata: {
              app: "dx-plugin",
              environment: input.environment,
              pluginId: input.pluginId,
              version: input.version,
              invocationId: input.invocationId,
            },
            allowInternetAccess: false,
            network: {
              allowOut: [...input.networkDestinations],
              denyOut: ({ allTraffic }) => [allTraffic],
              allowPublicTraffic: false,
            },
          }),
        catch: unavailable("sandbox.create"),
      }),
      (sandbox) =>
        Effect.gen(function* () {
          yield* Effect.tryPromise({
            try: async () => {
              await sandbox.files.makeDir("/plugin");
              await sandbox.files.makeDir("/project");
              await sandbox.files.makeDir("/runtime");
              await sandbox.files.write(
                input.sourceFiles.map((file) => ({
                  path: `/plugin/${file.path}`,
                  data: file.content,
                })),
              );
              if (input.projectFiles.length > 0) {
                await sandbox.files.write(
                  input.projectFiles.map((file) => ({
                    path: `/project/${file.path}`,
                    data: bytesBuffer(file.content),
                  })),
                );
              }
              await sandbox.files.write("/runtime/runner.mjs", runnerSource);
              await sandbox.files.write(
                "/runtime/invocation.json",
                serializedInvocation,
              );
            },
            catch: unavailable("sandbox.write-files"),
          });

          const forwardedSecrets = Object.keys(input.secrets)
            .map((name) => `${name}="$${name}"`)
            .join(" ");
          const command = [
            "/bin/bash --noprofile --norc -c '",
            "set +e; ",
            `(ulimit -t ${PLUGIN_CPU_TIME_LIMIT_SECONDS}; `,
            `ulimit -u ${PLUGIN_PROCESS_LIMIT}; `,
            `ulimit -v ${PLUGIN_MEMORY_LIMIT_KIB}; `,
            "ulimit -f 128; ",
            "exec env -i PATH=/usr/local/bin:/usr/bin:/bin HOME=/tmp ",
            forwardedSecrets,
            ` timeout --signal=KILL ${PLUGIN_WALL_TIME_LIMIT_MS / 1_000}s `,
            "node /runtime/runner.mjs) ",
            ">/runtime/stdout 2>/runtime/stderr; ",
            "printf %s $? >/runtime/status; exit 0'",
          ].join("");
          yield* Effect.tryPromise({
            try: () =>
              sandbox.commands.run(command, {
                timeoutMs: PLUGIN_WALL_TIME_LIMIT_MS + 2_000,
                envs: { ...input.secrets },
                cwd: "/runtime",
              }),
            catch: unavailable("sandbox.run"),
          });
          const status = yield* Effect.tryPromise({
            try: () => sandbox.files.read("/runtime/status"),
            catch: unavailable("sandbox.read-status"),
          });
          if (status.trim() !== "0") {
            return yield* new PluginExecutionLimited();
          }
          const rawResult = yield* Effect.tryPromise({
            try: () => sandbox.files.read("/runtime/result.json"),
            catch: unavailable("sandbox.read-result"),
          });
          if (
            new TextEncoder().encode(rawResult).byteLength >
            PLUGIN_OUTPUT_LIMIT_BYTES + 1_024
          ) {
            return yield* new PluginExecutionLimited();
          }
          const parsed = yield* Effect.try({
            try: () => JSON.parse(rawResult) as unknown,
            catch: unavailable("sandbox.parse-result"),
          });
          return yield* Schema.decodeUnknownEffect(
            Schema.Struct({
              result: Schema.Unknown,
              truncated: Schema.Boolean,
            }),
          )(parsed).pipe(Effect.mapError(unavailable("sandbox.decode-result")));
        }),
      (sandbox) =>
        Effect.tryPromise({
          try: () => sandbox.kill(),
          catch: unavailable("sandbox.kill"),
        }).pipe(Effect.ignore),
    );
  }),
});

export const PluginIsolationLive = (bindings: Bindings) =>
  Layer.effect(
    PluginIsolation,
    Effect.gen(function* () {
      const requirements = yield* loadE2BRequirements(bindings).pipe(
        Effect.mapError(unavailable("e2b.requirements")),
      );
      return makePluginIsolation(liveE2BPluginApi, {
        apiKey: Redacted.value(requirements.apiKey),
      });
    }),
  );

const blockedProjectNames = new Set([
  ".git",
  ".env",
  "credentials.json",
  "id_rsa",
  "id_ed25519",
  "node_modules",
  "secrets",
]);

export const snapshotPluginProject = Effect.fn("snapshotPluginProject")(
  function* (sandbox: FlueSandbox) {
    const files: Array<PluginProjectFile> = [];
    let totalBytes = 0;
    const walk = (relative: string, depth: number): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (depth > 8 || files.length >= PLUGIN_PROJECT_FILE_LIMIT) return;
        const entries = yield* Effect.tryPromise(() =>
          sandbox.readdir(relative === "" ? "." : relative),
        ).pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
        for (const name of [...entries].sort()) {
          if (
            name.startsWith(".") ||
            blockedProjectNames.has(name.toLowerCase()) ||
            name.endsWith(".pem") ||
            name.endsWith(".key")
          ) {
            continue;
          }
          const path = relative === "" ? name : `${relative}/${name}`;
          const stat = yield* Effect.tryPromise(() => sandbox.stat(path)).pipe(
            Effect.option,
          );
          if (Option.isNone(stat) || stat.value.isSymbolicLink === true)
            continue;
          if (stat.value.isDirectory) {
            yield* walk(path, depth + 1);
            continue;
          }
          if (
            !stat.value.isFile ||
            (stat.value.size !== undefined &&
              stat.value.size > PLUGIN_PROJECT_FILE_BYTES_LIMIT)
          ) {
            continue;
          }
          const content = yield* Effect.tryPromise(() =>
            sandbox.readFileBuffer(path),
          ).pipe(Effect.option);
          if (Option.isNone(content)) continue;
          if (
            content.value.byteLength > PLUGIN_PROJECT_FILE_BYTES_LIMIT ||
            totalBytes + content.value.byteLength > PLUGIN_PROJECT_BYTES_LIMIT
          ) {
            continue;
          }
          files.push({ path, content: content.value });
          totalBytes += content.value.byteLength;
          if (files.length >= PLUGIN_PROJECT_FILE_LIMIT) return;
        }
      });
    yield* walk("", 0);
    return files;
  },
);

const canonicalBundle = (version: StoredPluginVersion) => ({
  source: version.source,
  files: version.files.map((file) => ({
    path: file.path,
    kind: "file" as const,
    mediaType: file.mediaType,
    encoding: "utf-8" as const,
    content: file.content,
  })),
});

const pluginDependencies = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const repositories = Layer.mergeAll(
    PluginRepositoryD1(db),
    EnvironmentVariableRepositoryD1(db),
    McpServerRepositoryD1(db),
  ).pipe(Layer.provide(d1));
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  return Layer.mergeAll(repositories, workspace, settings, policy);
};

const enforcePersonalPluginResourcePolicy = Effect.fn(
  "enforcePersonalPluginResourcePolicy",
)(function* (target: PluginTarget, active: StoredPluginVersion) {
  if (target.scope === "workspace") return;
  const policies = yield* WorkspacePolicyService;
  if (active.grants.secretReferences.length > 0) {
    yield* policies.evaluateForUser(target.id, {
      kind: "secret.use-personal-override",
    });
  }
  if (active.grants.mcpServerIds.length > 0) {
    yield* policies.evaluateForUser(target.id, {
      kind: "mcp.use-personal-override",
    });
  }
});

const resolveGrantedSecrets = Effect.fn("resolveGrantedSecrets")(function* (
  bindings: Bindings,
  target: PluginTarget,
  grants: StoredPluginVersion["grants"],
  dependencies: ReturnType<typeof pluginDependencies>,
) {
  if (grants.secretReferences.length === 0) {
    return {} as Record<string, string>;
  }
  const keyring = yield* loadConfigEncryptionKeyring(bindings).pipe(
    Effect.mapError(unavailable("secrets.load-keyring")),
  );
  return yield* Effect.gen(function* () {
    const variables = yield* EnvironmentVariableRepository;
    return Object.fromEntries(
      yield* Effect.all(
        grants.secretReferences.map(({ name, reference }) =>
          Effect.gen(function* () {
            const variable = yield* variables.find(target, reference.id);
            if (
              variable.kind !== "secret" ||
              !variable.enabled ||
              String(variable.name) !== String(name)
            ) {
              return yield* forbidden("secrets.grant-check")();
            }
            const value = yield* decryptEnvironmentVariable(
              keyring,
              {
                id: variable.id,
                target: variable.target,
                name: variable.name,
                kind: variable.kind,
              },
              variable.envelope,
            ).pipe(Effect.mapError(unavailable("secrets.decrypt", false)));
            return [name, value] as const;
          }),
        ),
        { concurrency: 4 },
      ),
    ) as Record<string, string>;
  }).pipe(
    Effect.provide(dependencies),
    Effect.mapError((failure) =>
      isPluginExecutionError(failure)
        ? failure
        : failure instanceof EnvironmentVariableNotFound
          ? forbidden("secrets.find")(failure)
          : unavailable("secrets.find")(failure),
    ),
  );
});

const resolveGrantedMcpServers = Effect.fn("resolveGrantedMcpServers")(
  function* (
    target: PluginTarget,
    grants: StoredPluginVersion["grants"],
    dependencies: ReturnType<typeof pluginDependencies>,
  ) {
    return yield* Effect.gen(function* () {
      const servers = yield* McpServerRepository;
      return yield* Effect.all(
        grants.mcpServerIds.map((id) =>
          servers.find(target, id).pipe(
            Effect.flatMap(({ server, tools }) => {
              const reviewedTools = tools.filter(
                (tool) =>
                  tool.approvedSchemaHash !== undefined &&
                  tool.approvedSchemaHash === tool.schemaHash,
              );
              return server.enabled && reviewedTools.length > 0
                ? Effect.succeed({
                    id: server.id,
                    endpoint: server.endpoint,
                    tools: reviewedTools.map(({ name }) => name),
                  })
                : Effect.fail(forbidden("mcp.grant-check")());
            }),
          ),
        ),
        { concurrency: 4 },
      );
    }).pipe(
      Effect.provide(dependencies),
      Effect.mapError((failure) =>
        failure instanceof PluginExecutionForbidden
          ? failure
          : failure instanceof McpServerNotFound
            ? forbidden("mcp.find")(failure)
            : unavailable("mcp.find")(failure),
      ),
    );
  },
);

export const invokePlugin = Effect.fn("invokePlugin")(function* (
  bindings: Bindings,
  rawThreadId: string,
  rawPluginId: string,
  rawVersion: string,
  capability: {
    readonly kind: "tool" | "lifecycle";
    readonly name: string;
  },
  input: unknown,
  projectSandbox: FlueSandbox,
) {
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(unavailable("d1.decode-binding")),
  );
  const threadId = yield* Schema.decodeEffect(ThreadId)(rawThreadId).pipe(
    Effect.mapError(forbidden("decode.thread-id")),
  );
  const pluginId = yield* Schema.decodeEffect(PluginId)(rawPluginId).pipe(
    Effect.mapError(forbidden("decode.plugin-id")),
  );
  const version = yield* Schema.decodeEffect(PluginVersion)(rawVersion).pipe(
    Effect.mapError(forbidden("decode.plugin-version")),
  );
  const dependencies = pluginDependencies(db);
  const invocationId = `pinv_${crypto.randomUUID()}`;
  const startedAt = Date.now();
  const outcome = yield* Effect.result(
    Effect.gen(function* () {
      const authorized = yield* Effect.gen(function* () {
        const repository = yield* PluginRepository;
        return yield* repository.findAuthorizedInvocation(
          threadId,
          pluginId,
          version,
        );
      }).pipe(
        Effect.provide(dependencies),
        Effect.mapError(forbidden("plugin.authorize")),
      );
      const active = authorized.active;
      if (
        active.trusted !== true ||
        (capability.kind === "tool"
          ? !active.grants.tools.includes(capability.name as PluginToolName) ||
            !active.manifest.tools.some(({ name }) => name === capability.name)
          : !active.grants.lifecycle.includes(
              capability.name as PluginLifecycleEvent,
            ) ||
            !active.manifest.lifecycle.some(
              ({ event }) => event === capability.name,
            ))
      ) {
        return yield* forbidden("plugin.capability-grant")();
      }
      const reviewed = yield* previewPluginImport(canonicalBundle(active)).pipe(
        Effect.mapError(forbidden("plugin.review-bundle")),
      );
      if (
        reviewed.integrity !== active.integrity ||
        reviewed.manifest.version !== active.version
      ) {
        return yield* forbidden("plugin.integrity")();
      }

      yield* enforcePersonalPluginResourcePolicy(
        authorized.plugin.target,
        active,
      ).pipe(
        Effect.provide(dependencies),
        Effect.mapError((failure) =>
          failure instanceof WorkspacePolicyDenied
            ? failure
            : unavailable("plugin.resource-policy")(failure),
        ),
      );

      const secrets = yield* resolveGrantedSecrets(
        bindings,
        authorized.plugin.target,
        active.grants,
        dependencies,
      );
      const mcp = yield* resolveGrantedMcpServers(
        authorized.plugin.target,
        active.grants,
        dependencies,
      );
      const projectFiles = active.grants.filesystem.includes("project-read")
        ? yield* snapshotPluginProject(projectSandbox)
        : [];

      yield* Effect.gen(function* () {
        const repository = yield* PluginRepository;
        const current = yield* repository.findAuthorizedInvocation(
          threadId,
          pluginId,
          version,
        );
        yield* enforcePersonalPluginResourcePolicy(
          current.plugin.target,
          current.active,
        );
      }).pipe(
        Effect.provide(dependencies),
        Effect.mapError((failure) =>
          failure instanceof WorkspacePolicyDenied
            ? failure
            : forbidden("plugin.reauthorize")(failure),
        ),
      );

      const isolation = yield* PluginIsolation;
      return yield* isolation.invoke({
        environment:
          typeof bindings.DX_ENV === "string" ? bindings.DX_ENV : "unknown",
        pluginId,
        version,
        invocationId,
        entrypoint: active.manifest.entrypoint,
        sourceFiles: active.files.map(({ path, content }) => ({
          path,
          content,
        })),
        projectFiles,
        networkDestinations: active.grants.networkDestinations,
        secrets,
        invocation: {
          kind: capability.kind,
          name: capability.name,
          input,
          context: {
            attribution: { pluginId, version, invocationId },
            projectRoot: active.grants.filesystem.includes("project-read")
              ? "/project"
              : undefined,
            secretNames: Object.keys(secrets),
            mcp,
            agent: active.grants.agentCapabilities.includes("thread-metadata")
              ? { threadId }
              : undefined,
          },
        },
      });
    }),
  );
  const durationMs = Math.min(60_000, Date.now() - startedAt);
  const succeeded = Result.isSuccess(outcome);
  const auditOutcome = succeeded
    ? "success"
    : outcome.failure instanceof PluginExecutionLimited
      ? "limited"
      : outcome.failure instanceof PluginExecutionForbidden ||
          outcome.failure instanceof WorkspacePolicyDenied
        ? "rejected"
        : "failed";
  const createdAt = yield* DateTime.now;
  yield* Effect.gen(function* () {
    const repository = yield* PluginRepository;
    yield* repository.recordInvocation({
      invocationId,
      threadId,
      pluginId,
      version,
      capabilityKind: capability.kind,
      capabilityName: capability.name,
      outcome: auditOutcome,
      durationMs,
      createdAt,
    });
    if (!(Result.isFailure(outcome) && auditOutcome === "rejected")) {
      const authorized = yield* repository.findAuthorizedInvocation(
        threadId,
        pluginId,
        version,
      );
      yield* repository.updateState(
        authorized.plugin.target,
        pluginId,
        { healthStatus: succeeded ? "healthy" : "unhealthy" },
        createdAt,
      );
    }
  }).pipe(
    Effect.provide(dependencies),
    Effect.tapError((failure) =>
      Effect.sync(() => {
        logger.warn("Plugin invocation audit write failed.", {
          event: "plugin_invocation_audit_failed",
          invocationId,
          pluginId,
          version,
          outcome: auditOutcome,
          cause: failure,
        });
      }),
    ),
    Effect.ignore,
  );
  if (Result.isFailure(outcome)) return yield* outcome.failure;
  return {
    attribution: {
      pluginId,
      version,
      invocationId,
      capability: capability.name,
    },
    result: outcome.success.result,
    truncated: outcome.success.truncated,
  };
});

export const invokePluginTrigger = Effect.fn("invokePluginTrigger")(function* (
  bindings: Bindings,
  triggerId: string,
  deliveryId: string,
  eventId: string,
  idempotencyKey: string,
  attempt: number,
  payload: unknown,
) {
  const db = yield* decodeD1Binding(bindings.DB).pipe(
    Effect.mapError(unavailable("d1.decode-binding")),
  );
  const authorized = yield* loadAuthorizedTriggerDelivery(db, triggerId).pipe(
    Effect.mapError(triggerAuthorizationExecutionError),
  );
  const active = authorized.version;
  const reviewed = yield* previewPluginImport(canonicalBundle(active)).pipe(
    Effect.mapError(forbidden("plugin.review-bundle")),
  );
  if (
    reviewed.integrity !== active.integrity ||
    reviewed.manifest.version !== active.version
  ) {
    return yield* forbidden("plugin.integrity")();
  }
  const dependencies = pluginDependencies(db);
  const secrets = yield* resolveGrantedSecrets(
    bindings,
    authorized.target,
    active.grants,
    dependencies,
  );
  const mcp = yield* resolveGrantedMcpServers(
    authorized.target,
    active.grants,
    dependencies,
  );

  yield* loadAuthorizedTriggerDelivery(db, triggerId).pipe(
    Effect.mapError(triggerAuthorizationExecutionError),
  );
  const invocationId = `pinv_${crypto.randomUUID()}`;
  const isolation = yield* PluginIsolation;
  const output = yield* isolation.invoke({
    environment:
      typeof bindings.DX_ENV === "string" ? bindings.DX_ENV : "unknown",
    pluginId: active.pluginId,
    version: active.version,
    invocationId,
    entrypoint: active.manifest.entrypoint,
    sourceFiles: active.files.map(({ path, content }) => ({ path, content })),
    projectFiles: [],
    networkDestinations: active.grants.networkDestinations,
    secrets,
    invocation: {
      kind: "trigger",
      name: authorized.trigger.action,
      input: {
        event: payload,
        eventId,
        idempotencyKey,
        deliveryId,
        attempt,
      },
      context: {
        attribution: {
          pluginId: active.pluginId,
          version: active.version,
          invocationId,
          triggerId,
          deliveryId,
        },
        secretNames: Object.keys(secrets),
        mcp,
      },
    },
  });
  return {
    attribution: {
      pluginId: active.pluginId,
      version: active.version,
      invocationId,
      triggerId,
      deliveryId,
    },
    result: output.result,
    truncated: output.truncated,
  };
});

export const invokePluginLive = (
  rawThreadId: string,
  rawPluginId: string,
  rawVersion: string,
  capability: {
    readonly kind: "tool" | "lifecycle";
    readonly name: string;
  },
  input: unknown,
  projectSandbox: FlueSandbox,
) =>
  Effect.runPromise(
    invokePlugin(
      env as Bindings,
      rawThreadId,
      rawPluginId,
      rawVersion,
      capability,
      input,
      projectSandbox,
    ).pipe(Effect.provide(PluginIsolationLive(env as Bindings))),
  );

const VersionAgentRow = Schema.Struct({
  plugin_id: Schema.String,
  version: Schema.String,
  manifest_json: Schema.String,
  grants_json: Schema.String,
  integrity: Schema.String,
  trusted: Schema.Finite,
});

const parseJson = <A>(
  value: string,
): Effect.Effect<A, PluginExecutionUnavailable> =>
  Effect.try({
    try: () => JSON.parse(value) as A,
    catch: unavailable("agent-data.parse-json"),
  });

export const resolvePluginAgentData = Effect.fn("resolvePluginAgentData")(
  function* (binding: unknown, thread: Thread) {
    const db = yield* decodeD1Binding(binding).pipe(
      Effect.mapError(unavailable("d1.decode-binding")),
    );
    return yield* Effect.all(
      thread.plugins.map((snapshot) =>
        Effect.gen(function* () {
          const row = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `SELECT plugin_id, version, manifest_json, grants_json,
                          integrity, trusted
                     FROM trusted_plugin_version
                    WHERE plugin_id = ? AND version = ? LIMIT 1`,
                )
                .bind(snapshot.id, snapshot.version)
                .first(),
            catch: unavailable("agent-data.query-version"),
          });
          if (row === null) {
            return yield* unavailable("agent-data.version-missing")();
          }
          const decoded = yield* Schema.decodeUnknownEffect(VersionAgentRow)(
            row,
          ).pipe(Effect.mapError(unavailable("agent-data.decode-row")));
          if (
            decoded.plugin_id !== snapshot.id ||
            decoded.version !== snapshot.version ||
            decoded.integrity !== snapshot.integrity ||
            decoded.trusted !== 1
          ) {
            return yield* unavailable("agent-data.version-mismatch")();
          }
          const manifest = yield* parseJson<unknown>(
            decoded.manifest_json,
          ).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(PluginManifest)),
            Effect.mapError(unavailable("agent-data.decode-manifest")),
          );
          const grants = yield* parseJson<{
            readonly tools?: ReadonlyArray<string>;
            readonly lifecycle?: ReadonlyArray<string>;
          }>(decoded.grants_json);
          const tools = manifest.tools.filter(({ name }) =>
            grants.tools?.includes(name),
          );
          const lifecycle = manifest.lifecycle
            .map(({ event }) => event)
            .filter((event) => grants.lifecycle?.includes(event));
          return {
            id: snapshot.id,
            version: snapshot.version,
            name: snapshot.name,
            scope: snapshot.scope,
            integrity: snapshot.integrity,
            displayName: manifest.displayName,
            description: manifest.description,
            tools,
            lifecycle,
          };
        }),
      ),
      { concurrency: 4 },
    );
  },
);
