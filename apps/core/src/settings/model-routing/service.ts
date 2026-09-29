import { randomUUID } from "node:crypto";
import type {
  ConnectionData,
  CreateConnectionRequestSchema,
  PutModeRequestSchema,
  SettingsFieldError,
  UpdateConnectionRequestSchema,
} from "@dx/api";
import type { Profile } from "@dx/domain";
import {
  customModelBaseUrlForFormatChange,
  EnvironmentVariableId,
  EnvironmentVariablePlaintext,
  MAX_CONNECTION_HEADERS,
  MAX_CONNECTION_MODELS,
  MAX_MODEL_CONNECTIONS_PER_SCOPE,
  MODE_IDS,
  ModeConfig,
  type ModeId,
  ModelConnectionId,
  ModelConnectionTarget,
  ModelCredentialId,
  ModelRoutingRepository,
  ModeProfileOverrideRepository,
  StoredModelConnection,
  Timestamp,
  type UserId,
  untestedModelConnectionHealth,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import {
  catalogProviderModels,
  type ProviderFieldSpec,
  pickerProviders,
  supportedProvider,
} from "./catalog.js";
import {
  loadConnectionsForTarget,
  loadRoutableConnections,
  loadSubscriptionModelIds,
} from "./connection-store-d1.js";
import { effectiveContextWindow } from "./context-window.js";
import { COPILOT_SERVED_MODELS } from "./copilot-mapping.js";
import { DEFAULT_PROFILE } from "./defaults.js";
import { validateAllowedModelEndpoint } from "./endpoint-policy.js";
import { ModeProfileOverrideRepositoryD1 } from "./mode-profile-override-repository-d1.js";
import {
  encryptModelCredential,
  MODEL_CREDENTIAL_ID_PREFIX,
} from "./model-credential-encryption.js";
import {
  ModelCredentialRepository,
  ModelCredentialRepositoryD1,
  type StoredModelCredential,
} from "./model-credential-repository-d1.js";
import { ModelRoutingRepositoryD1 } from "./repository-d1.js";
import {
  canonicalCapabilities,
  canonicalModelKnown,
  findServingConnection,
} from "./resolver.js";

export type CreateConnectionInput = typeof CreateConnectionRequestSchema.Type;
export type UpdateConnectionInput = typeof UpdateConnectionRequestSchema.Type;

/** Field-level validation failure rendered as `fieldErrors` on 400s. */
export class ModelRoutingValidationError extends Error {
  readonly _tag = "ModelRoutingValidationError";
  constructor(readonly fieldErrors: ReadonlyArray<SettingsFieldError>) {
    super("Model routing validation failed.");
  }
}

export class ModelConnectionNotFoundError extends Error {
  readonly _tag = "ModelConnectionNotFoundError";
}

export class ModelRoutingPersistenceError extends Error {
  readonly _tag = "ModelRoutingPersistenceError";
  constructor(readonly cause?: unknown) {
    super("Model routing persistence failed.");
  }
}

export const CUSTOM_PROVIDER_ID = "dx-custom";

/** Headers a connection may never set — auth and transport stay owned. */
const RESERVED_HEADERS = new Set([
  "authorization",
  "x-api-key",
  "api-key",
  "x-goog-api-key",
  "host",
  "content-length",
  "connection",
  "proxy-authorization",
]);

const mask = (value: string): string => `••••${value.slice(-4)}`;

const toConnectionData = (
  connection: StoredModelConnection,
  credential: { present: boolean; tail?: string } | undefined,
): ConnectionData => ({
  id: connection.id,
  name: connection.name,
  kind: connection.kind,
  providerId: connection.providerId,
  ...(connection.baseUrl === undefined ? {} : { baseUrl: connection.baseUrl }),
  ...(connection.format === undefined ? {} : { format: connection.format }),
  fields: connection.fields,
  headers: connection.headers.map((header) => ({
    name: header.name,
    masked: mask(header.value),
  })),
  models: connection.models.map((model) => ({
    canonical: model.canonical,
    ...(model.upstream === undefined ? {} : { upstream: model.upstream }),
  })),
  enabled: connection.enabled,
  priority: connection.priority,
  health: connection.health,
  ...(credential === undefined ? {} : { credential }),
  serves: connection.kind === "custom" ? "declared" : "catalog",
  createdAt: connection.createdAt,
  updatedAt: connection.updatedAt,
});

const now = () => Schema.decodeUnknownSync(Timestamp)(new Date().toISOString());

const modeResolution = <A>(modes: ReadonlyMap<ModeId, A>, mode: ModeId): A => {
  const resolution = modes.get(mode);
  if (resolution === undefined) {
    throw new ModelRoutingPersistenceError("Missing required mode resolution.");
  }
  return resolution;
};

const endpointError = (
  endpoint: string,
  allowlist: string | undefined,
  fieldErrors: SettingsFieldError[],
) => {
  const result = validateAllowedModelEndpoint(endpoint, allowlist);
  if ("error" in result) {
    fieldErrors.push({
      field: "baseUrl",
      message:
        result.error === "not-allowlisted"
          ? "This endpoint origin is not in the deployment model endpoint allowlist."
          : "Use a public HTTPS endpoint without credentials, query parameters, fragments, or private/local addressing.",
    });
  }
};

const normalizedEndpoint = (
  endpoint: string,
  allowlist: string | undefined,
) => {
  const result = validateAllowedModelEndpoint(endpoint, allowlist);
  return "endpoint" in result ? result.endpoint : undefined;
};

const validateHeaders = (
  headers: ReadonlyArray<{ name: string; value: string }>,
  fieldErrors: SettingsFieldError[],
) => {
  const seen = new Set<string>();
  headers.forEach((header, index) => {
    const normalizedName = header.name.toLowerCase();
    if (RESERVED_HEADERS.has(normalizedName)) {
      fieldErrors.push({
        field: `headers.${index}.name`,
        message: `Header ${header.name} is managed by dx and cannot be overridden.`,
      });
    }
    if (seen.has(normalizedName)) {
      fieldErrors.push({
        field: `headers.${index}.name`,
        message: `Duplicate header ${header.name}.`,
      });
    }
    seen.add(normalizedName);
  });
  if (headers.length > MAX_CONNECTION_HEADERS) {
    fieldErrors.push({
      field: "headers",
      message: `At most ${MAX_CONNECTION_HEADERS} custom headers.`,
    });
  }
};

const validateFields = (
  specFields: ReadonlyArray<ProviderFieldSpec>,
  fields: Record<string, string>,
  fieldErrors: SettingsFieldError[],
) => {
  for (const spec of specFields) {
    if (spec.required && (fields[spec.key] ?? "").trim() === "") {
      fieldErrors.push({
        field: `fields.${spec.key}`,
        message: `${spec.label} is required.`,
      });
    }
  }
};

const validateModels = (
  models: ReadonlyArray<{ canonical: string; upstream?: string }>,
  fieldErrors: SettingsFieldError[],
) => {
  if (models.length === 0) {
    fieldErrors.push({
      field: "models",
      message: "Declare at least one model.",
    });
  }
  if (models.length > MAX_CONNECTION_MODELS) {
    fieldErrors.push({
      field: "models",
      message: `At most ${MAX_CONNECTION_MODELS} models.`,
    });
  }
  const seen = new Set<string>();
  models.forEach((model, index) => {
    if (!canonicalModelKnown(model.canonical)) {
      fieldErrors.push({
        field: `models.${index}.canonical`,
        message: `Unknown model ${model.canonical} — pick a model from the catalog.`,
      });
    }
    if (seen.has(model.canonical)) {
      fieldErrors.push({
        field: `models.${index}.canonical`,
        message: `Duplicate model ${model.canonical}.`,
      });
    }
    seen.add(model.canonical);
  });
};

const validateModeConfig = (
  config: ModeConfig,
  fieldErrors: SettingsFieldError[],
) => {
  const slots = [
    ["agent.model", config.agent.model],
    ["oracle.model", config.oracle?.model],
    ["subagents.model", config.subagents?.model],
  ] as const;
  for (const [field, model] of slots) {
    if (model !== undefined && !canonicalModelKnown(model)) {
      fieldErrors.push({
        field,
        message: `Unknown model ${model} — pick a model from the catalog.`,
      });
    }
  }
};

/** Health probe injected by routes (backed by the coordinator DO). */
export type CheckAccessProbe = (
  target: ModelConnectionTarget,
  connectionId: string,
) => Promise<StoredModelConnection["health"]>;

const modelLayers = (db: D1Database) =>
  Layer.mergeAll(
    ModelRoutingRepositoryD1(db),
    ModeProfileOverrideRepositoryD1(db),
    ModelCredentialRepositoryD1(db),
  );

export class ModelRoutingService {
  constructor(
    private readonly db: D1Database,
    private readonly keyring: ConfigEncryptionKeyring,
    private readonly defaultProfile: Profile = DEFAULT_PROFILE,
    private readonly extraConnections: ReadonlyArray<StoredModelConnection> = [],
    private readonly endpointAllowlist?: string,
    private readonly deploymentProviders?: string,
  ) {}

  #run<A>(
    effect: Effect.Effect<
      A,
      unknown,
      | ModelRoutingRepository
      | ModeProfileOverrideRepository
      | ModelCredentialRepository
    >,
  ): Promise<A> {
    return Effect.runPromise(
      effect.pipe(
        Effect.provide(modelLayers(this.db)),
        Effect.catchTags({
          PersistenceUnavailable: (error: { operation: string }) =>
            error.operation === "settings.modelRouting.connectionLimit"
              ? Effect.fail(
                  new ModelRoutingValidationError([
                    {
                      field: "name",
                      message: `At most ${MAX_MODEL_CONNECTIONS_PER_SCOPE} connections per scope.`,
                    },
                  ]),
                )
              : Effect.fail(new ModelRoutingPersistenceError(error)),
          ModelConnectionNotFound: () =>
            Effect.fail(new ModelConnectionNotFoundError()),
          SchemaError: (error: unknown) =>
            Effect.fail(
              new ModelRoutingValidationError([
                {
                  field: "request",
                  message: `Invalid value. ${String(
                    (error as { message?: unknown })?.message ?? error,
                  ).slice(0, 400)}`,
                },
              ]),
            ),
        }),
      ) as Effect.Effect<A, Error>,
    );
  }

  async #credentialData(
    connection: StoredModelConnection,
  ): Promise<{ present: boolean; tail?: string } | undefined> {
    if (connection.kind === "deployment") return undefined;
    if (connection.kind === "subscription") {
      const row = await this.db
        .prepare(
          `SELECT status FROM personal_model_subscription_connection
           WHERE id = ? AND owner_user_id = ?`,
        )
        .bind(connection.id, connection.target.id)
        .first<{ status: string }>();
      return { present: row?.status === "connected" };
    }
    if (connection.credentialId === undefined) return { present: false };
    return { present: true };
  }

  async #connectionData(
    connection: StoredModelConnection,
  ): Promise<ConnectionData> {
    return toConnectionData(connection, await this.#credentialData(connection));
  }

  async listConnections(
    target: ModelConnectionTarget,
  ): Promise<ConnectionData[]> {
    const connections = await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        return yield* repository.listConnections(target);
      }),
    );
    return Promise.all(
      connections.map((connection) => this.#connectionData(connection)),
    );
  }

  #validateCreate(input: CreateConnectionInput): SettingsFieldError[] {
    const fieldErrors: SettingsFieldError[] = [];
    if (input.kind === "subscription" || input.kind === "deployment") {
      fieldErrors.push({
        field: "kind",
        message:
          input.kind === "subscription"
            ? "Connect subscriptions from their provider flow."
            : "Deployment connections are composed by the runtime.",
      });
      return fieldErrors;
    }
    if (input.baseUrl !== undefined) {
      endpointError(input.baseUrl, this.endpointAllowlist, fieldErrors);
    }
    if (input.kind === "provider") {
      const spec = supportedProvider(input.providerId);
      if (spec === undefined || spec.connectionKind !== "provider") {
        fieldErrors.push({
          field: "providerId",
          message: `Unsupported provider ${input.providerId}.`,
        });
      } else {
        validateFields(spec.fields, input.fields ?? {}, fieldErrors);
      }
      if ((input.apiKey ?? "") === "") {
        fieldErrors.push({ field: "apiKey", message: "API key is required." });
      }
      if (input.models !== undefined && input.models.length > 0) {
        fieldErrors.push({
          field: "models",
          message: "Provider connections serve their whole catalog.",
        });
      }
      if (input.format !== undefined) {
        fieldErrors.push({
          field: "format",
          message: "API format applies to custom connections only.",
        });
      }
    }
    if (input.kind === "custom") {
      if (input.providerId !== CUSTOM_PROVIDER_ID) {
        fieldErrors.push({
          field: "providerId",
          message: `Custom connections use provider id ${CUSTOM_PROVIDER_ID}.`,
        });
      }
      if ((input.baseUrl ?? "").trim() === "") {
        fieldErrors.push({
          field: "baseUrl",
          message: "Base URL is required.",
        });
      }
      if (input.format === undefined) {
        fieldErrors.push({
          field: "format",
          message: "Pick the API format this endpoint speaks.",
        });
      }
      if ((input.apiKey ?? "") === "") {
        fieldErrors.push({ field: "apiKey", message: "API key is required." });
      }
      validateModels(input.models ?? [], fieldErrors);
    }
    validateHeaders(input.headers ?? [], fieldErrors);
    return fieldErrors;
  }

  async #buildCredential(
    target: ModelConnectionTarget,
    connectionName: string,
    apiKey: string,
    timestamp: string,
  ): Promise<StoredModelCredential> {
    const credentialId = Schema.decodeUnknownSync(ModelCredentialId)(
      `${MODEL_CREDENTIAL_ID_PREFIX}${randomUUID()}`,
    );
    const credentialName = `${connectionName} key`;
    const keyring = this.keyring;
    return await this.#run(
      Effect.gen(function* () {
        const envelope = yield* encryptModelCredential(
          keyring,
          {
            id: Schema.decodeUnknownSync(EnvironmentVariableId)(credentialId),
            target,
            name: credentialName,
          },
          Schema.decodeUnknownSync(EnvironmentVariablePlaintext)(apiKey),
        );
        const stored = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            id: ModelCredentialId,
            target: ModelConnectionTarget,
            name: Schema.String,
            envelope: Schema.Unknown,
            createdAt: Timestamp,
            updatedAt: Timestamp,
          }),
        )({
          id: credentialId,
          target,
          name: credentialName,
          envelope,
          createdAt: timestamp,
          updatedAt: timestamp,
        });
        return stored as StoredModelCredential;
      }),
    );
  }

  async createConnection(
    target: ModelConnectionTarget,
    input: CreateConnectionInput,
  ): Promise<ConnectionData> {
    const fieldErrors = this.#validateCreate(input);
    const existing = await loadConnectionsForTarget(this.db, target);
    if (existing.length >= MAX_MODEL_CONNECTIONS_PER_SCOPE) {
      fieldErrors.push({
        field: "name",
        message: `At most ${MAX_MODEL_CONNECTIONS_PER_SCOPE} connections per scope.`,
      });
    }
    if (existing.some((connection) => connection.name === input.name)) {
      fieldErrors.push({
        field: "name",
        message: "A connection with this name already exists.",
      });
    }
    if (fieldErrors.length > 0)
      throw new ModelRoutingValidationError(fieldErrors);

    const timestamp = new Date().toISOString();
    const endpointResult =
      input.baseUrl === undefined
        ? undefined
        : normalizedEndpoint(input.baseUrl, this.endpointAllowlist);
    const apiKey = input.apiKey;
    const credential =
      apiKey === undefined || apiKey === ""
        ? undefined
        : await this.#buildCredential(target, input.name, apiKey, timestamp);
    const priority =
      existing.length === 0
        ? 0
        : Math.max(...existing.map((connection) => connection.priority)) + 1;
    const connection = Schema.decodeUnknownSync(StoredModelConnection)({
      id: `mcon_${randomUUID()}`,
      target,
      name: input.name,
      kind: input.kind,
      providerId: input.providerId,
      ...(endpointResult === undefined ? {} : { baseUrl: endpointResult }),
      ...(input.format === undefined ? {} : { format: input.format }),
      fields: input.fields ?? {},
      headers: input.headers ?? [],
      models: input.models ?? [],
      enabled: input.enabled ?? true,
      priority,
      health: untestedModelConnectionHealth(),
      ...(credential === undefined ? {} : { credentialId: credential.id }),
      createdAt: timestamp,
      updatedAt: timestamp,
    });
    await this.#run(
      Effect.gen(function* () {
        if (credential === undefined) {
          const repository = yield* ModelRoutingRepository;
          yield* repository.insertConnection(connection);
        } else {
          const credentials = yield* ModelCredentialRepository;
          yield* credentials.insertConnection(connection, credential);
        }
      }),
    );
    return this.#connectionData(connection);
  }

  async updateConnection(
    target: ModelConnectionTarget,
    id: string,
    input: UpdateConnectionInput,
  ): Promise<ConnectionData> {
    const current = await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        return yield* repository.findConnection(
          target,
          Schema.decodeUnknownSync(ModelConnectionId)(id),
        );
      }),
    );
    if (current.kind === "subscription" || current.kind === "deployment") {
      throw new ModelRoutingValidationError([
        {
          field: "connectionId",
          message: "This connection is managed by its provider flow.",
        },
      ]);
    }
    const fieldErrors: SettingsFieldError[] = [];
    const merged = { ...current, ...input };
    if (typeof input.baseUrl === "string") {
      endpointError(input.baseUrl, this.endpointAllowlist, fieldErrors);
    }
    if (current.kind === "provider") {
      const spec = supportedProvider(current.providerId);
      if (spec !== undefined)
        validateFields(spec.fields, merged.fields ?? {}, fieldErrors);
      if (merged.models !== undefined && merged.models.length > 0) {
        fieldErrors.push({
          field: "models",
          message: "Provider connections serve their whole catalog.",
        });
      }
    }
    if (current.kind === "custom") {
      if (input.baseUrl === null) {
        fieldErrors.push({
          field: "baseUrl",
          message: "Base URL is required.",
        });
      }
      if (merged.models !== undefined)
        validateModels(merged.models, fieldErrors);
    }
    validateHeaders(merged.headers ?? [], fieldErrors);
    const siblings = (await loadConnectionsForTarget(this.db, target)).filter(
      (connection) => connection.id !== id,
    );
    if (
      merged.name !== undefined &&
      siblings.some((connection) => connection.name === merged.name)
    ) {
      fieldErrors.push({
        field: "name",
        message: "A connection with this name already exists.",
      });
    }
    if (fieldErrors.length > 0)
      throw new ModelRoutingValidationError(fieldErrors);

    const timestamp = new Date().toISOString();
    const endpointResult =
      input.baseUrl === undefined
        ? current.kind === "custom" &&
          current.baseUrl !== undefined &&
          current.format !== undefined &&
          merged.format !== undefined &&
          merged.format !== current.format
          ? customModelBaseUrlForFormatChange(current.format, current.baseUrl)
          : current.baseUrl
        : input.baseUrl === null
          ? undefined
          : normalizedEndpoint(input.baseUrl, this.endpointAllowlist);
    let credentialId = current.credentialId;
    let replacementCredential: StoredModelCredential | undefined;
    const apiKey = input.apiKey;
    if (apiKey !== undefined && apiKey !== "") {
      replacementCredential = await this.#buildCredential(
        target,
        merged.name ?? current.name,
        apiKey,
        timestamp,
      );
      credentialId = replacementCredential.id;
    }
    const { baseUrl: _currentBaseUrl, ...encodedCurrent } = Schema.encodeSync(
      StoredModelConnection,
    )(current);
    const next = Schema.decodeUnknownSync(StoredModelConnection)({
      ...encodedCurrent,
      ...(merged.name === undefined ? {} : { name: merged.name }),
      ...(endpointResult === undefined ? {} : { baseUrl: endpointResult }),
      ...(merged.format === undefined ? {} : { format: merged.format }),
      fields: merged.fields ?? current.fields,
      headers: merged.headers ?? current.headers,
      models: merged.models ?? current.models,
      ...(credentialId === undefined ? {} : { credentialId }),
      updatedAt: timestamp,
    });
    await this.#run(
      Effect.gen(function* () {
        if (replacementCredential === undefined) {
          const repository = yield* ModelRoutingRepository;
          yield* repository.replaceConnection(next);
        } else {
          const credentials = yield* ModelCredentialRepository;
          yield* credentials.rotateConnection(
            next,
            current.credentialId,
            replacementCredential,
          );
        }
      }),
    );
    return this.#connectionData(next);
  }

  async setEnabled(
    target: ModelConnectionTarget,
    id: string,
    enabled: boolean,
  ): Promise<ConnectionData> {
    const current = await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        return yield* repository.findConnection(
          target,
          Schema.decodeUnknownSync(ModelConnectionId)(id),
        );
      }),
    );
    const next: StoredModelConnection = {
      ...current,
      enabled,
      updatedAt: now(),
    };
    await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        yield* repository.replaceConnection(next);
      }),
    );
    return this.#connectionData(next);
  }

  async reorderConnections(
    target: ModelConnectionTarget,
    orderedIds: ReadonlyArray<string>,
  ): Promise<ConnectionData[]> {
    await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        yield* repository.reorderConnections(
          target,
          orderedIds.map((id) =>
            Schema.decodeUnknownSync(ModelConnectionId)(id),
          ),
        );
      }),
    );
    return this.listConnections(target);
  }

  async checkAccess(
    target: ModelConnectionTarget,
    id: string,
    probe: CheckAccessProbe,
  ): Promise<ConnectionData> {
    await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        return yield* repository.findConnection(
          target,
          Schema.decodeUnknownSync(ModelConnectionId)(id),
        );
      }),
    );
    await probe(target, id);
    const current = await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        return yield* repository.findConnection(
          target,
          Schema.decodeUnknownSync(ModelConnectionId)(id),
        );
      }),
    );
    return this.#connectionData(current);
  }

  async removeConnection(
    target: ModelConnectionTarget,
    id: string,
  ): Promise<void> {
    const current = await loadConnectionsForTarget(this.db, target);
    const connection = current.find((candidate) => candidate.id === id);
    if (connection === undefined) throw new ModelConnectionNotFoundError();
    if (connection.kind === "subscription") {
      throw new ModelRoutingValidationError([
        {
          field: "connectionId",
          message: "Disconnect subscriptions from their provider flow.",
        },
      ]);
    }
    await this.#run(
      Effect.gen(function* () {
        const repository = yield* ModelRoutingRepository;
        yield* repository.removeConnection(
          target,
          Schema.decodeUnknownSync(ModelConnectionId)(id),
        );
      }),
    );
  }

  // Catalog / graph / choices / profile (personal) -------------------------

  catalog(options?: { readonly includeSubscriptions?: boolean }): {
    providers: ReadonlyArray<{
      id: string;
      name: string;
      description: string;
      connectionKind: string;
      transport: string;
      fields: ReadonlyArray<ProviderFieldSpec>;
      models: ReadonlyArray<{
        id: string;
        name: string;
        contextWindow: number;
        maxOutputTokens: number;
        reasoning: boolean;
        vision: boolean;
      }>;
    }>;
  } {
    return {
      providers: pickerProviders(
        this.deploymentProviders,
        this.extraConnections.some(
          (connection) =>
            connection.kind === "deployment" &&
            connection.providerId === "cloudflare",
        ),
      )
        .filter(
          (spec) =>
            options?.includeSubscriptions !== false ||
            spec.connectionKind !== "subscription",
        )
        .map((spec) => ({
          id: spec.id,
          name: spec.name,
          description: spec.description,
          connectionKind: spec.connectionKind,
          transport: spec.transport,
          fields: spec.fields,
          models: catalogProviderModels(spec.id).map((model) => ({
            id: `${spec.id}/${model.id}`,
            name: model.name,
            contextWindow: effectiveContextWindow(
              `${spec.id}/${model.id}`,
              model.contextWindow,
            ),
            maxOutputTokens: model.maxTokens,
            reasoning: model.reasoning,
            vision: model.input.includes("image"),
          })),
        })),
    };
  }

  async #routable(userId: UserId, target?: ModelConnectionTarget) {
    const connections = [
      ...(target === undefined
        ? await loadRoutableConnections(this.db, userId)
        : await loadConnectionsForTarget(this.db, target)
      ).filter(
        (connection) =>
          connection.kind !== "subscription" ||
          connection.target.scope === "personal",
      ),
      ...this.extraConnections,
    ];
    const entitlements = new Map<string, ReadonlySet<string>>(
      await Promise.all(
        connections
          .filter((connection) => connection.kind === "subscription")
          .map(
            async (connection) =>
              [
                connection.id,
                new Set(
                  (await loadSubscriptionModelIds(
                    this.db,
                    userId,
                    connection.id,
                  )) ?? [],
                ),
              ] as const,
          ),
      ),
    );
    const defaultProfile = this.defaultProfile;
    const modes = new Map(
      await Effect.runPromise(
        Effect.gen(function* () {
          const overrides = yield* ModeProfileOverrideRepository;
          const rows = yield* overrides.listOverrides(userId, "default");
          return MODE_IDS.map(
            (mode) =>
              [
                mode,
                {
                  config:
                    rows.find((row) => row.mode === mode)?.config ??
                    defaultProfile.modes[mode],
                  source: rows.some((row) => row.mode === mode)
                    ? ("override" as const)
                    : ("default" as const),
                },
              ] as const,
          );
        }).pipe(Effect.provide(ModeProfileOverrideRepositoryD1(this.db))),
      ),
    );
    return { connections, entitlements, modes };
  }

  async graph(userId: UserId, target?: ModelConnectionTarget) {
    const { connections, entitlements, modes } = await this.#routable(
      userId,
      target,
    );
    const edges = MODE_IDS.map((mode) => {
      const config = modeResolution(modes, mode).config;
      const match = findServingConnection(
        connections,
        config.agent.model,
        (id) => entitlements.get(id),
      );
      return {
        mode,
        model: config.agent.model,
        connectionId: match?.connection.id ?? null,
      };
    });
    return {
      modes: MODE_IDS.map((mode) => {
        const resolution = modeResolution(modes, mode);
        const served =
          edges.find((edge) => edge.mode === mode)?.connectionId !== null;
        return {
          mode,
          config: {
            model: resolution.config.agent.model,
            thinking: resolution.config.agent.thinking,
          },
          source: resolution.source,
          served,
        };
      }),
      connections: connections.map((connection) => ({
        connectionId: connection.id,
        name: connection.name,
        kind: connection.kind,
        scope: connection.target.scope,
        priority: connection.priority,
        enabled: connection.enabled,
      })),
      edges,
    };
  }

  async choices(userId: UserId) {
    const { connections, entitlements, modes } = await this.#routable(userId);
    const candidates = new Set<string>();
    for (const connection of connections) {
      if (connection.kind === "subscription") {
        for (const canonical of COPILOT_SERVED_MODELS.keys())
          candidates.add(canonical);
        continue;
      }
      const canonicals =
        connection.kind === "custom"
          ? connection.models.map((model) => model.canonical)
          : catalogProviderModels(connection.providerId).map(
              (model) => `${connection.providerId}/${model.id}`,
            );
      for (const canonical of canonicals) candidates.add(canonical);
    }
    const served = new Map(
      [...candidates].flatMap((canonical) => {
        const match = findServingConnection(connections, canonical, (id) =>
          entitlements.get(id),
        );
        return match === undefined ? [] : [[canonical, match] as const];
      }),
    );
    return {
      modes: MODE_IDS.map((mode) => {
        const resolution = modeResolution(modes, mode);
        const match = findServingConnection(
          connections,
          resolution.config.agent.model,
          (id) => entitlements.get(id),
        );
        return {
          mode,
          config: {
            model: resolution.config.agent.model,
            thinking: resolution.config.agent.thinking,
          },
          source: resolution.source,
          served: match !== undefined,
          servingConnectionName: match?.connection.name ?? null,
        };
      }),
      models: [...served].map(([canonical, { connection }]) => {
        const capabilities = canonicalCapabilities(
          canonical,
          connection.kind === "subscription",
        ) ?? {
          contextWindow: 0,
          maxOutputTokens: 0,
          reasoning: false,
          vision: false,
        };
        return {
          canonical,
          name: canonical.split("/").at(-1) ?? canonical,
          connectionId: connection.id,
          connectionName: connection.name,
          contextWindow: capabilities.contextWindow,
          reasoning: capabilities.reasoning,
          vision: capabilities.vision,
        };
      }),
    };
  }

  async profile(userId: UserId) {
    const { modes } = await this.#routable(userId);
    return {
      id: "default" as const,
      modes: Object.fromEntries(
        MODE_IDS.map((mode) => {
          const resolution = modeResolution(modes, mode);
          return [
            mode,
            {
              config: resolution.config,
              source: resolution.source,
            },
          ];
        }),
      ),
    };
  }

  async putMode(
    userId: UserId,
    mode: ModeId,
    config: typeof PutModeRequestSchema.Type,
  ): Promise<Awaited<ReturnType<ModelRoutingService["profile"]>>> {
    const decoded = Schema.decodeUnknownOption(ModeConfig)(config);
    if (Option.isNone(decoded)) {
      throw new ModelRoutingValidationError([
        { field: "config", message: "Invalid mode configuration." },
      ]);
    }
    const fieldErrors: SettingsFieldError[] = [];
    validateModeConfig(decoded.value, fieldErrors);
    if (fieldErrors.length > 0)
      throw new ModelRoutingValidationError(fieldErrors);
    await this.#run(
      Effect.gen(function* () {
        const overrides = yield* ModeProfileOverrideRepository;
        yield* overrides.upsertOverride({
          userId,
          profileId: "default",
          mode,
          config: decoded.value,
          updatedAt: now(),
        });
      }),
    );
    return this.profile(userId);
  }

  async resetMode(
    userId: UserId,
    mode: ModeId,
  ): Promise<Awaited<ReturnType<ModelRoutingService["profile"]>>> {
    await this.#run(
      Effect.gen(function* () {
        const overrides = yield* ModeProfileOverrideRepository;
        yield* overrides.removeOverride(userId, "default", mode);
      }),
    );
    return this.profile(userId);
  }
}
