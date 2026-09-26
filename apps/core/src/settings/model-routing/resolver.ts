import {
  MODE_IDS,
  type ModeConfig,
  type ModeId,
  ModelNotServed,
  type ModelRoutingRepositoryShape,
  type ModeProfileOverrideRepositoryShape,
  type PersistenceUnavailable,
  type Profile,
  type ResolvedSubmissionModel,
  type StoredModelConnection,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import { catalogModelExists, findCatalogModel } from "./catalog.js";
import { COPILOT_SERVED_MODELS } from "./copilot-mapping.js";
import { DEFAULT_PROFILE } from "./defaults.js";

const canonicalParts = (canonical: string) => {
  const slash = canonical.indexOf("/");
  return {
    provider: canonical.slice(0, slash),
    model: canonical.slice(slash + 1),
  };
};

/** Canonical id known to either the pi-ai catalog or the Copilot mapping. */
export const canonicalModelKnown = (canonical: string): boolean =>
  catalogModelExists(canonical) || COPILOT_SERVED_MODELS.has(canonical);

/** Capabilities for a canonical id from the owning catalog. */
export const canonicalCapabilities = (
  canonical: string,
  subscription = false,
) => {
  const copilot = COPILOT_SERVED_MODELS.get(canonical);
  if (subscription && copilot !== undefined) return copilot.capabilities;
  const { provider, model } = canonicalParts(canonical);
  const entry = findCatalogModel(provider, model);
  return entry === undefined
    ? copilot?.capabilities
    : {
        contextWindow: entry.contextWindow,
        maxOutputTokens: entry.maxTokens,
        reasoning: entry.reasoning,
        vision: entry.input.includes("image"),
      };
};

/**
 * The upstream `model` string a connection sends for a canonical id, when
 * the connection serves it. `entitledCopilotIds` is the subscription's
 * entitlement list; undefined for non-subscription kinds.
 */
export const connectionUpstreamFor = (
  connection: StoredModelConnection,
  canonical: string,
  entitledCopilotIds?: ReadonlySet<string>,
): string | undefined => {
  switch (connection.kind) {
    case "custom": {
      const declared = connection.models.find(
        ({ canonical: id }) => id === canonical,
      );
      if (declared === undefined) return undefined;
      return declared.upstream ?? canonicalParts(canonical).model;
    }
    case "subscription": {
      const served = COPILOT_SERVED_MODELS.get(canonical);
      if (served === undefined) return undefined;
      return entitledCopilotIds !== undefined &&
        entitledCopilotIds.has(served.upstream)
        ? served.upstream
        : undefined;
    }
    case "provider":
    case "deployment": {
      const { provider, model } = canonicalParts(canonical);
      return connection.providerId === provider &&
        findCatalogModel(provider, model) !== undefined
        ? model
        : undefined;
    }
  }
};

export interface ServingMatch {
  readonly connection: StoredModelConnection;
  readonly upstreamModel: string;
}

export type CopilotEntitlements = (
  connectionId: string,
) => ReadonlySet<string> | undefined;

/**
 * First enabled connection (in list order) that serves the canonical id.
 * Callers pass personal connections then workspace connections — priority
 * order inside each scope (decision 12).
 */
export const findServingConnection = (
  connections: ReadonlyArray<StoredModelConnection>,
  canonical: string,
  copilotEntitlements: CopilotEntitlements = () => undefined,
): ServingMatch | undefined => {
  const ordered = [...connections].sort((a, b) => {
    const rank = (c: StoredModelConnection) =>
      c.kind === "deployment" ? 2 : c.target.scope === "personal" ? 0 : 1;
    const scope = rank(a) - rank(b);
    return scope !== 0 ? scope : a.priority - b.priority;
  });
  for (const connection of ordered) {
    if (!connection.enabled) continue;
    const upstreamModel = connectionUpstreamFor(
      connection,
      canonical,
      copilotEntitlements(connection.id),
    );
    if (upstreamModel !== undefined) return { connection, upstreamModel };
  }
  return undefined;
};

/** Why a canonical id has no serving connection. */
export const notServedReason = (
  connections: ReadonlyArray<StoredModelConnection>,
  canonical: string,
  copilotEntitlements: CopilotEntitlements = () => undefined,
): "no-connection" | "disabled" | "unknown-model" => {
  if (!canonicalModelKnown(canonical)) return "unknown-model";
  const declared = connections.some(
    (connection) =>
      connectionUpstreamFor(
        connection,
        canonical,
        copilotEntitlements(connection.id),
      ) !== undefined,
  );
  return declared ? "disabled" : "no-connection";
};

/** Raw-model threads carry no thinking slot; use a neutral default. */
export const RAW_MODEL_THINKING = "high" as const;

export interface ResolveSubmissionInput {
  readonly selection: ThreadModelSelection;
  /** Personal then workspace connections, each in priority order. */
  readonly connections: ReadonlyArray<StoredModelConnection>;
  readonly defaultProfile: Profile;
  readonly modeOverrides: ReadonlyMap<ModeId, ModeConfig>;
  readonly copilotEntitlements?: CopilotEntitlements;
}

/** Per-submission resolution (decision 24); never persisted. */
export const resolveSubmissionModel = (
  input: ResolveSubmissionInput,
): ResolvedSubmissionModel => {
  const modeConfig =
    input.selection.kind === "mode"
      ? (input.modeOverrides.get(input.selection.mode) ??
        input.defaultProfile.modes[input.selection.mode])
      : undefined;
  const slot = modeConfig?.agent;
  const model =
    input.selection.kind === "mode" ? slot!.model : input.selection.model;
  const thinking =
    input.selection.kind === "mode" ? slot!.thinking : RAW_MODEL_THINKING;
  const entitlements = input.copilotEntitlements ?? (() => undefined);
  const match = findServingConnection(input.connections, model, entitlements);
  if (match === undefined) {
    throw new ModelNotServed({
      model,
      reason: notServedReason(input.connections, model, entitlements),
    });
  }
  const capabilities = canonicalCapabilities(
    model,
    match.connection.kind === "subscription",
  ) ?? {
    contextWindow: 0,
    maxOutputTokens: 0,
    reasoning: false,
    vision: false,
  };
  return {
    model,
    upstreamModel: match.upstreamModel,
    thinking,
    connection: {
      id: match.connection.id,
      scope: match.connection.target.scope,
      kind: match.connection.kind,
      providerId: match.connection.providerId,
      name: match.connection.name,
    },
    capabilities,
  };
};

// --------------------------------------------------------------------------
// Effect service for routes and runtime wiring.
// --------------------------------------------------------------------------

export interface ModeResolution {
  readonly config: ModeConfig;
  readonly source: "default" | "override";
}

export interface ModelResolverShape {
  /** Effective mode configs: user override else the active default profile. */
  readonly effectiveModes: (
    userId: UserId,
  ) => Effect.Effect<
    ReadonlyMap<ModeId, ModeResolution>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  /**
   * All connections a user can route through: personal list (priority order)
   * then the workspace lists of every workspace they belong to.
   */
  readonly routableConnections: (
    userId: UserId,
  ) => Effect.Effect<
    ReadonlyArray<StoredModelConnection>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  /** Copilot entitlement model ids per subscription connection. */
  readonly copilotEntitlements: (
    userId: UserId,
    connections: ReadonlyArray<StoredModelConnection>,
  ) => Effect.Effect<
    ReadonlyMap<string, ReadonlySet<string>>,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly resolveSubmission: (
    userId: UserId,
    selection: ThreadModelSelection,
  ) => Effect.Effect<
    ResolvedSubmissionModel,
    ModelNotServed | PersistenceUnavailable | Schema.SchemaError
  >;
}

export class ModelResolver extends Context.Service<
  ModelResolver,
  ModelResolverShape
>()("@dx/core/settings/model-routing/ModelResolver") {}

/**
 * `workspaceTargetIds` resolves every workspace the user belongs to (member
 * rows) — the resolver's workspace candidate pool (decision 12).
 * `subscriptionModelIds` loads the Copilot entitlement list for one
 * subscription connection. `defaultProfile`/`extraConnections` let dev and
 * preview composition point modes at the deployment binding (decision 20).
 */
export const ModelResolverLive = (deps: {
  readonly modelRouting: ModelRoutingRepositoryShape;
  readonly overrides: ModeProfileOverrideRepositoryShape;
  readonly workspaceTargetIds: (
    userId: UserId,
  ) => Effect.Effect<ReadonlyArray<string>, PersistenceUnavailable>;
  readonly subscriptionModelIds: (
    userId: UserId,
    connectionId: string,
  ) => Effect.Effect<
    ReadonlyArray<string> | undefined,
    PersistenceUnavailable | Schema.SchemaError
  >;
  readonly defaultProfile?: Profile;
  readonly extraConnections?: ReadonlyArray<StoredModelConnection>;
}) =>
  Layer.succeed(
    ModelResolver,
    (() => {
      const defaultProfile = deps.defaultProfile ?? DEFAULT_PROFILE;
      const extras = deps.extraConnections ?? [];
      const routableConnections: ModelResolverShape["routableConnections"] =
        Effect.fn("ModelResolver.routableConnections")(function* (userId) {
          const personal = yield* deps.modelRouting.listConnections({
            scope: "personal",
            id: userId,
          });
          const workspaceIds = yield* deps.workspaceTargetIds(userId);
          const workspace = yield* Effect.all(
            workspaceIds.map((id) =>
              deps.modelRouting.listConnections({
                scope: "workspace",
                id: id as never,
              }),
            ),
          );
          return [...personal, ...workspace.flat(), ...extras];
        });
      const copilotEntitlements: ModelResolverShape["copilotEntitlements"] =
        Effect.fn("ModelResolver.copilotEntitlements")(
          function* (userId, connections) {
            const subscriptions = connections.filter(
              (connection) => connection.kind === "subscription",
            );
            return yield* Effect.all(
              subscriptions.map((connection) =>
                Effect.map(
                  deps.subscriptionModelIds(userId, connection.id),
                  (ids) =>
                    [connection.id, new Set(ids ?? [])] as [
                      string,
                      ReadonlySet<string>,
                    ],
                ),
              ),
            ).pipe(Effect.map((entries) => new Map(entries)));
          },
        );
      const effectiveModes: ModelResolverShape["effectiveModes"] = Effect.fn(
        "ModelResolver.effectiveModes",
      )(function* (userId) {
        const overrides = yield* deps.overrides.listOverrides(
          userId,
          "default",
        );
        const byMode = new Map(overrides.map((row) => [row.mode, row.config]));
        return new Map(
          MODE_IDS.map((mode) => [
            mode,
            {
              config: byMode.get(mode) ?? defaultProfile.modes[mode],
              source: (byMode.has(mode) ? "override" : "default") as
                | "override"
                | "default",
            },
          ]),
        );
      });
      return ModelResolver.of({
        effectiveModes,
        routableConnections,
        copilotEntitlements,
        resolveSubmission: Effect.fn("ModelResolver.resolveSubmission")(
          function* (userId, selection) {
            const [connections, modes] = yield* Effect.all([
              routableConnections(userId),
              effectiveModes(userId),
            ]);
            const entitlements = yield* copilotEntitlements(
              userId,
              connections,
            );
            const modeOverrides = new Map(
              [...modes]
                .filter(([, mode]) => mode.source === "override")
                .map(([mode, modeResolution]) => [mode, modeResolution.config]),
            );
            return yield* Effect.try({
              try: () =>
                resolveSubmissionModel({
                  selection,
                  connections,
                  defaultProfile,
                  modeOverrides,
                  copilotEntitlements: (connectionId) =>
                    entitlements.get(connectionId),
                }),
              catch: (cause) => cause as ModelNotServed,
            });
          },
        ),
      });
    })(),
  );
