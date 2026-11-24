import {
  MODE_IDS,
  ModelProviderId,
  type Profile,
  type StoredModelConnection,
  type Timestamp,
} from "@dx/domain";
import type { Api, Model } from "@earendil-works/pi-ai";
import { Schema } from "effect";
import {
  type DeploymentModels,
  DX_PROVIDER_ID,
  type DxModel,
  type DxUpstream,
  EMPTY_DEPLOYMENT_MODELS,
} from "./deployment-model-source.js";
import { registeredDeploymentModelSource } from "./deployment-models-registration.js";

export type {
  DeploymentModels,
  DxModel,
  DxUpstream,
} from "./deployment-model-source.js";

/**
 * Models the installation provides, shown to everyone as **dx**.
 *
 * An admin enables upstreams (inference services the installation pays
 * for, described by deployment-upstreams.ts; the presets are the
 * deployment's own) and
 * offers their models under a dx alias. People see only `dx/<alias>`, its
 * dx name, and the provider "dx": the upstream's name, model id, base URL,
 * and key stay in Core. Each enabled upstream becomes one synthetic
 * `deployment` connection named "dx", ranked after people's own keys, so a
 * personal or workspace key for the same canonical model still wins.
 *
 * The configuration lives in the deployment's own store, read through the
 * registered `DeploymentModelSource`; public dx registers none.
 */
export { DX_PROVIDER_ID } from "./deployment-model-source.js";
export const DX_CONNECTION_NAME = "dx" as const;
const DX_CONNECTION_PREFIX = "deployment-dx-";

let current: DeploymentModels = EMPTY_DEPLOYMENT_MODELS;

/**
 * The installation's dx models, from the registered source. The latest
 * load also serves the catalog and the resolver, which run synchronously.
 */
export const loadDeploymentModels = async (
  db: D1Database | undefined,
): Promise<DeploymentModels> => {
  current = await registeredDeploymentModelSource.load(db);
  return current;
};

/** The dx models the latest load offers. */
const configuredModels = (): ReadonlyArray<DxModel> => current.models;

/**
 * A dx alias's name as the admin set it, served now or not: "dx Flash"
 * while its upstream is off, instead of the bare alias.
 */
export const dxModelName = (alias: string): string | undefined =>
  findDxModel(alias)?.name ?? current.names?.get(alias);

/** Each configured dx model not served now, as `dx/<alias>` and its name. */
export const unservedDxModels = (): ReadonlyArray<{
  readonly canonical: string;
  readonly name: string;
}> =>
  [...(current.names ?? new Map<string, string>())].flatMap(([alias, name]) =>
    findDxModel(alias) === undefined
      ? [{ canonical: `${DX_PROVIDER_ID}/${alias}`, name }]
      : [],
  );

export const findDxModel = (id: string): DxModel | undefined =>
  configuredModels().find((model) => model.id === id);

/** The dx catalog: canonical `dx/<alias>` entries with dx names only. */
export const dxCatalogModels = (): ReadonlyArray<Model<Api>> =>
  configuredModels().map(
    (model) =>
      ({
        id: model.id,
        name: model.name,
        api: model.api,
        provider: DX_PROVIDER_ID,
        baseUrl: model.baseUrl,
        reasoning: model.capabilities.reasoning,
        input: model.capabilities.vision ? ["text", "image"] : ["text"],
        cost: { ...model.price },
        contextWindow: model.capabilities.contextWindow,
        maxTokens: model.capabilities.maxTokens,
        compat: { ...model.upstream.compat, ...model.capabilities.compat },
        ...(model.capabilities.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.capabilities.thinkingLevelMap }),
      }) as Model<Api>,
  );

// Routing -------------------------------------------------------------------

/** The dx connection of an upstream the deployment enabled; its id names no upstream. */
export const dxConnectionId = (upstreamId: string) =>
  `${DX_CONNECTION_PREFIX}${upstreamId}` as StoredModelConnection["id"];

/** Whether a connection id names one of the installation's dx connections. */
export const isDxConnectionId = (id: string) =>
  id.startsWith(DX_CONNECTION_PREFIX);

export const isDxConnection = (connection: StoredModelConnection) =>
  connection.kind === "deployment" && connection.providerId === DX_PROVIDER_ID;

/** The enabled upstream a dx connection forwards to. */
export const dxConnectionUpstreamId = (
  connection: StoredModelConnection,
): string | undefined =>
  isDxConnection(connection) && isDxConnectionId(connection.id)
    ? connection.id.slice(DX_CONNECTION_PREFIX.length)
    : undefined;

/** The upstream a dx connection forwards to, when it is enabled. */
export const dxConnectionUpstream = (
  connection: StoredModelConnection,
): DxUpstream | undefined => {
  const id = dxConnectionUpstreamId(connection);
  return current.upstreams.find((upstream) => upstream.id === id);
};

/**
 * The upstream model a dx connection sends for `dx/<alias>`, when that
 * connection's upstream is the one serving the alias.
 */
export const dxUpstreamModel = (
  connection: StoredModelConnection,
  alias: string,
): string | undefined => {
  const upstreamId = dxConnectionUpstreamId(connection);
  const model = findDxModel(alias);
  return upstreamId !== undefined && model?.upstreamId === upstreamId
    ? model.upstreamModel
    : undefined;
};

/** One upstream a dx call can go to, with what the coordinator needs to reach it. */
export interface DxCallRoute {
  readonly upstreamId: string;
  readonly upstreamModel: string;
  readonly api: string;
  readonly baseUrl: string;
  /** The Settings provider it connects as, for its adapter and auth. */
  readonly providerId?: string;
  readonly fields: Readonly<Record<string, string>>;
  readonly headers: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

/**
 * Where a call on `dx/<alias>` pinned to `connection` may go, in order: the
 * connection's own upstream first while it still serves the alias, then the
 * alias's other serving upstreams by priority. Only routes that speak `api`,
 * since the agent has already written the request in that format. Empty
 * once no upstream serves the alias.
 */
export const dxCallRoutes = (
  connection: StoredModelConnection,
  alias: string,
  api: string,
): ReadonlyArray<DxCallRoute> => {
  const model = findDxModel(alias);
  if (model === undefined || !isDxConnection(connection)) return [];
  const pinned = dxConnectionUpstreamId(connection);
  const routes = [model, ...(model.fallbacks ?? [])];
  return [
    ...routes.filter(({ upstreamId }) => upstreamId === pinned),
    ...routes.filter(({ upstreamId }) => upstreamId !== pinned),
  ].flatMap((route) => {
    const upstream = current.upstreams.find(
      ({ id }) => id === route.upstreamId,
    );
    return upstream === undefined || route.api !== api
      ? []
      : [
          {
            upstreamId: route.upstreamId,
            upstreamModel: route.upstreamModel,
            api: route.api,
            baseUrl: route.baseUrl,
            ...(route.upstream.providerId === undefined
              ? {}
              : { providerId: route.upstream.providerId }),
            fields: upstream.fields ?? {},
            headers: upstream.headers ?? [],
          },
        ];
  });
};

/** One "dx" connection per enabled upstream serving a model. */
export const dxConnections = (
  models: DeploymentModels,
  now: Timestamp,
): ReadonlyArray<StoredModelConnection> =>
  models.upstreams
    .filter(({ id }) => models.models.some((model) => model.upstreamId === id))
    .map((upstream, index) => ({
      id: dxConnectionId(upstream.id),
      target: { scope: "workspace", id: "deployment" as never },
      name: DX_CONNECTION_NAME as StoredModelConnection["name"],
      kind: "deployment",
      providerId: Schema.decodeUnknownSync(ModelProviderId)(DX_PROVIDER_ID),
      fields: {},
      headers: [],
      models: [],
      enabled: true,
      // Before the dev Workers AI connection, after everything people add.
      priority: Number.MAX_SAFE_INTEGER - 1_000 + index,
      health: { state: "untested", code: "DEPLOYMENT_CONFIGURED" },
      createdAt: now,
      updatedAt: now,
    }));

/** The admin's mode defaults over a base profile. */
export const withDxModes = (
  base: Profile,
  models: DeploymentModels,
): Profile => {
  if (models.modes.size === 0) return base;
  return {
    ...base,
    modes: Object.fromEntries(
      MODE_IDS.map((mode) => [
        mode,
        models.modes.get(mode) ?? base.modes[mode],
      ]),
    ) as Profile["modes"],
  };
};

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

/**
 * The words that name an upstream: its preset's, its endpoints' hosts, and
 * the admin's field values (an Azure resource, an AI Gateway id). Longest
 * first, so a host goes before the brand inside it.
 */
const upstreamWords = (served: DxUpstream): ReadonlyArray<string> =>
  [
    ...new Set([
      ...served.upstream.redact,
      ...[
        served.baseUrl,
        ...current.models
          .filter(({ upstreamId }) => upstreamId === served.id)
          .map(({ baseUrl }) => baseUrl),
      ].flatMap((url) => hostOf(url) ?? []),
      ...Object.values(served.fields ?? {}),
    ]),
  ]
    .filter((word) => word.length >= 3)
    .toSorted((left, right) => right.length - left.length);

/** Removes every upstream's name from text a person may see on a dx connection. */
export const scrubUpstreamText = (
  connection: StoredModelConnection,
  text: string,
): string => {
  if (!isDxConnection(connection)) return text;
  // Every upstream's words: a call may have gone to a fallback.
  const words = [...new Set(current.upstreams.flatMap(upstreamWords))].toSorted(
    (left, right) => right.length - left.length,
  );
  return words.reduce(
    (scrubbed, word) => scrubbed.split(word).join(DX_PROVIDER_ID),
    text,
  );
};
