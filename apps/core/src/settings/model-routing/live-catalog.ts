import type { Api, Model } from "@earendil-works/pi-ai";
import {
  getBuiltinModels,
  getBuiltinProviders,
} from "@earendil-works/pi-ai/providers/all";
import { settingsPersistenceLogger } from "../../logging.js";

/**
 * The models dx learns at runtime, on top of the pi catalog pinned in the
 * build. Labs release models every week; a provider serves them the day they
 * ship, and dx lists them without a release:
 *
 * - models.dev (https://models.dev/api.json), the open catalog opencode
 *   keeps current, read by the Worker's cron every few hours;
 * - what a provider reports live: GitHub Copilot's `/models` for a
 *   connected account, and Anthropic's `/v1/models` for a Claude Pro/Max
 *   plan.
 *
 * Both are stored in D1 (`model_catalog_source`) and every isolate reads
 * them into memory, so the catalog functions stay synchronous. A model pi
 * already lists keeps pi's entry: pi knows its wire traits. A model only
 * observed here borrows the wire traits (api, compat, thinking map, headers)
 * of the closest model of its family on the same pi provider, and takes its
 * id, name, limits, flags and price from what was observed.
 */

export interface ObservedModel {
  readonly id: string;
  /** Absent when the source named none; another source's name, else the id, is used. */
  readonly name?: string;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
  readonly reasoning?: boolean;
  readonly vision?: boolean;
  /** USD per million tokens. */
  readonly cost?: Model<Api>["cost"];
  /** Copilot: the request paths it serves the model on. */
  readonly endpoints?: ReadonlyArray<string>;
  /** Epoch ms the source last reported it; live sources age out. */
  readonly observedAt?: number;
}

type ObservedByProvider = Readonly<
  Record<string, ReadonlyArray<ObservedModel>>
>;

export interface LiveCatalog {
  /** models.dev entries per pi provider id. */
  readonly modelsDev: ObservedByProvider;
  /** Provider-reported models per provider id (`github-copilot`, `claude-code`). */
  readonly discovered: ObservedByProvider;
  /** Changes whenever the content changes; memoized views key on it. */
  readonly revision: string;
  readonly modelsDevFetchedAt?: number;
}

const EMPTY: LiveCatalog = { modelsDev: {}, discovered: {}, revision: "0" };

export const MODELS_DEV_URL = "https://models.dev/api.json";
const MODELS_DEV_SOURCE = "models.dev";
const discoveredSource = (provider: string) => `discovered:${provider}`;
/** models.dev changes daily at most; the cron reads it this often. */
export const MODELS_DEV_REFRESH_MS = 6 * 60 * 60 * 1_000;
/** An isolate rereads D1 at most this often. */
const RELOAD_MS = 60 * 1_000;
/** A provider-reported model nobody has seen for this long is dropped. */
const DISCOVERED_TTL_MS = 30 * 24 * 60 * 60 * 1_000;

let current: LiveCatalog = EMPTY;
let loadedAt = Number.NEGATIVE_INFINITY;
/**
 * When a read of this isolate started, so a loaded isolate starts one read a
 * minute. A timestamp, never a shared promise: in a Worker a promise belongs
 * to the request that created it, and once that request ends the promise can
 * never settle, so another request awaiting it would throw forever (#2486).
 */
let readingSince = Number.NEGATIVE_INFINITY;
/** A read this old is taken as lost (its request ended before it settled). */
const READ_TIMEOUT_MS = 30 * 1_000;

/**
 * Whether this isolate has read D1 since it started or was told to read it
 * again (a models.dev refresh); a request after that can use what it holds.
 */
export const liveCatalogLoaded = () => loadedAt !== Number.NEGATIVE_INFINITY;

/** The runtime catalog this isolate holds; empty until loaded. */
export const liveCatalog = (): LiveCatalog => current;

const hash = (text: string) => {
  let value = 2_166_136_261;
  for (let index = 0; index < text.length; index += 1) {
    value ^= text.charCodeAt(index);
    value = Math.imul(value, 16_777_619) >>> 0;
  }
  return value.toString(16).padStart(8, "0");
};

const setCatalog = (
  next: Omit<LiveCatalog, "revision">,
  now: number,
): LiveCatalog => {
  const revision = hash(
    JSON.stringify([next.modelsDev, stripObservedAt(next.discovered)]),
  );
  current = revision === current.revision ? current : { ...next, revision };
  current =
    current.modelsDevFetchedAt === next.modelsDevFetchedAt
      ? current
      : { ...current, modelsDevFetchedAt: next.modelsDevFetchedAt };
  loadedAt = now;
  return current;
};

/** Revision ignores when a live model was last seen, only what it is. */
const stripObservedAt = (byProvider: ObservedByProvider) =>
  Object.fromEntries(
    Object.entries(byProvider).map(([provider, models]) => [
      provider,
      models.map(({ observedAt: _, ...model }) => model),
    ]),
  );

/** Replaces the isolate's catalog; for tests and local fixtures. */
export const setLiveCatalogForTesting = (
  next: Partial<Omit<LiveCatalog, "revision">>,
) =>
  setCatalog(
    { modelsDev: next.modelsDev ?? {}, discovered: next.discovered ?? {} },
    Date.now(),
  );

interface SourceRow {
  readonly source: string;
  readonly models_json: string;
  readonly fetched_at: number;
}

const parseRows = (rows: ReadonlyArray<SourceRow>) => {
  let modelsDev: ObservedByProvider = {};
  let modelsDevFetchedAt: number | undefined;
  const discovered: Record<string, ReadonlyArray<ObservedModel>> = {};
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.models_json);
    } catch {
      continue;
    }
    if (row.source === MODELS_DEV_SOURCE) {
      if (typeof parsed === "object" && parsed !== null) {
        modelsDev = parsed as ObservedByProvider;
        modelsDevFetchedAt = row.fetched_at;
      }
    } else if (row.source.startsWith("discovered:") && Array.isArray(parsed)) {
      discovered[row.source.slice("discovered:".length)] =
        parsed as ReadonlyArray<ObservedModel>;
    }
  }
  return { modelsDev, discovered, modelsDevFetchedAt };
};

/**
 * Reads the runtime catalog from D1 into this isolate, at most once a
 * minute. Callers await it before reading the catalog: the Worker on each
 * request, and the credential coordinators before they resolve a model. A
 * failed read keeps what the isolate had; the pinned catalog always works.
 */
export const loadLiveCatalog = async (
  db: D1Database | undefined,
  now = Date.now(),
): Promise<LiveCatalog> => {
  if (db === undefined || now - loadedAt < RELOAD_MS) return current;
  // A loaded isolate keeps what it holds while another request reads. An
  // isolate with nothing loaded reads for each request instead of waiting on
  // another request's read.
  if (liveCatalogLoaded() && now - readingSince < READ_TIMEOUT_MS)
    return current;
  readingSince = now;
  try {
    const { results } = await db
      .prepare(
        "SELECT source, models_json, fetched_at FROM model_catalog_source",
      )
      .all<SourceRow>();
    setCatalog(parseRows(results), now);
  } catch (cause) {
    // The table is missing until the migration runs; keep the pinned catalog.
    loadedAt = now;
    settingsPersistenceLogger.warn("Live model catalog read failed.", {
      event: "live_model_catalog_read_failed",
      cause,
    });
  } finally {
    readingSince = Number.NEGATIVE_INFINITY;
  }
  return current;
};

const store = async (
  db: D1Database,
  source: string,
  models: unknown,
  now: number,
) =>
  db
    .prepare(
      `INSERT INTO model_catalog_source (source, models_json, fetched_at)
       VALUES (?, ?, ?)
       ON CONFLICT (source) DO UPDATE SET
         models_json = excluded.models_json,
         fetched_at = excluded.fetched_at`,
    )
    .bind(source, JSON.stringify(models), now)
    .run();

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value) && value >= 0
    ? value
    : undefined;

const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;

const strings = (value: unknown): ReadonlyArray<string> =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];

/**
 * One models.dev model as dx observes it, or undefined when it cannot run
 * an agent turn: no tool calls, output that is not text (image, speech,
 * embeddings), or deprecated.
 */
const fromModelsDev = (raw: unknown): ObservedModel | undefined => {
  const model = record(raw);
  if (model === undefined || typeof model.id !== "string") return undefined;
  if (model.tool_call !== true || model.status === "deprecated")
    return undefined;
  const modalities = record(model.modalities);
  const input = strings(modalities?.input);
  const output = strings(modalities?.output);
  if (!input.includes("text") || output.join() !== "text") return undefined;
  const limit = record(model.limit);
  const price = record(model.cost);
  const contextWindow = finite(limit?.context);
  const maxTokens = finite(limit?.output);
  return {
    id: model.id,
    ...(typeof model.name === "string" && model.name
      ? { name: model.name }
      : {}),
    ...(contextWindow ? { contextWindow } : {}),
    ...(maxTokens ? { maxTokens } : {}),
    reasoning: model.reasoning === true,
    vision: input.includes("image"),
    ...(price === undefined
      ? {}
      : {
          cost: {
            input: finite(price.input) ?? 0,
            output: finite(price.output) ?? 0,
            cacheRead: finite(price.cache_read) ?? 0,
            cacheWrite: finite(price.cache_write) ?? 0,
          },
        }),
  };
};

/**
 * models.dev's agent-capable models for each pi provider dx can serve. The
 * full file is ~7 MB across hundreds of providers; dx keeps only its own.
 */
export const parseModelsDev = (raw: unknown): ObservedByProvider => {
  const providers = record(raw) ?? {};
  const known = new Set<string>(getBuiltinProviders());
  return Object.fromEntries(
    Object.entries(providers).flatMap(([id, provider]) => {
      if (!known.has(id)) return [];
      const models = Object.values(record(record(provider)?.models) ?? {})
        .map(fromModelsDev)
        .filter((model): model is ObservedModel => model !== undefined);
      return models.length === 0 ? [] : [[id, models]];
    }),
  );
};

export type ModelsDevRefresh =
  | { readonly status: "fresh" }
  | { readonly status: "refreshed"; readonly models: number }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Reads models.dev into D1 when the stored copy is older than
 * `MODELS_DEV_REFRESH_MS` (or `force`). Runs from the Worker's cron; a
 * failure keeps the last good copy.
 */
export const refreshModelsDev = async (
  db: D1Database,
  options: {
    readonly fetch?: typeof fetch;
    readonly now?: number;
    readonly force?: boolean;
  } = {},
): Promise<ModelsDevRefresh> => {
  const now = options.now ?? Date.now();
  const stored = await db
    .prepare("SELECT fetched_at FROM model_catalog_source WHERE source = ?")
    .bind(MODELS_DEV_SOURCE)
    .first<{ fetched_at: number }>();
  if (
    !options.force &&
    stored !== null &&
    now - stored.fetched_at < MODELS_DEV_REFRESH_MS
  )
    return { status: "fresh" };
  try {
    const response = await (options.fetch ?? fetch)(MODELS_DEV_URL, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok)
      return { status: "failed", reason: `HTTP ${response.status}` };
    const byProvider = parseModelsDev(await response.json());
    const models = Object.values(byProvider).reduce(
      (total, list) => total + list.length,
      0,
    );
    if (models === 0) return { status: "failed", reason: "empty catalog" };
    await store(db, MODELS_DEV_SOURCE, byProvider, now);
    loadedAt = Number.NEGATIVE_INFINITY;
    return { status: "refreshed", models };
  } catch (cause) {
    return {
      status: "failed",
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
};

/** When this isolate started reading models.dev; a timestamp, as above. */
let seedingSince = Number.NEGATIVE_INFINITY;
/** refreshModelsDev's fetch gives up after 30 s; allow the D1 writes too. */
const SEED_TIMEOUT_MS = 2 * 60 * 1_000;

/**
 * A deployment whose D1 holds no models.dev copy yet (a new install, a
 * fresh preview) reads it now instead of waiting for the cron, whose first
 * tick on a new Worker can take minutes. One read per isolate at a time.
 */
export const seedModelsDev = (
  db: D1Database | undefined,
  waitUntil: (promise: Promise<unknown>) => void,
) => {
  const now = Date.now();
  if (
    db === undefined ||
    current.modelsDevFetchedAt !== undefined ||
    now - seedingSince < SEED_TIMEOUT_MS
  )
    return;
  seedingSince = now;
  const seeding = refreshModelsDev(db)
    .then(() => loadLiveCatalog(db))
    .catch((cause) =>
      settingsPersistenceLogger.warn("models.dev catalog seed failed.", {
        event: "models_dev_catalog_seed_failed",
        cause,
      }),
    )
    .finally(() => {
      seedingSince = Number.NEGATIVE_INFINITY;
    });
  waitUntil(seeding);
};

/**
 * Stores the models a provider reported for a connected account, merged
 * with what other accounts reported, and makes them visible in this isolate
 * at once. A model's description is the same for every account; which
 * models an account may use stays with its connection.
 */
export const recordDiscoveredModels = async (
  db: D1Database | undefined,
  provider: string,
  models: ReadonlyArray<ObservedModel>,
  now = Date.now(),
): Promise<void> => {
  if (models.length === 0) return;
  const seen = new Map(
    (current.discovered[provider] ?? [])
      .filter(({ observedAt }) => now - (observedAt ?? now) < DISCOVERED_TTL_MS)
      .map((model) => [model.id, model]),
  );
  if (db !== undefined) {
    const row = await db
      .prepare("SELECT models_json FROM model_catalog_source WHERE source = ?")
      .bind(discoveredSource(provider))
      .first<{ models_json: string }>()
      .catch(() => null);
    const stored = row === null ? [] : JSON.parse(row.models_json);
    for (const model of Array.isArray(stored)
      ? (stored as ObservedModel[])
      : [])
      if (now - (model.observedAt ?? now) < DISCOVERED_TTL_MS)
        seen.set(model.id, model);
  }
  for (const model of models) seen.set(model.id, { ...model, observedAt: now });
  const merged = [...seen.values()];
  setCatalog(
    {
      modelsDev: current.modelsDev,
      discovered: { ...current.discovered, [provider]: merged },
      modelsDevFetchedAt: current.modelsDevFetchedAt,
    },
    loadedAt,
  );
  if (db === undefined) return;
  await store(db, discoveredSource(provider), merged, now).catch((cause) =>
    settingsPersistenceLogger.warn("Discovered models were not stored.", {
      event: "live_model_catalog_store_failed",
      provider,
      cause,
    }),
  );
};

/**
 * Whether what a provider last reported is older than `maxAgeMs`, or it
 * never reported: the caller lists its models again with a credential it
 * already holds.
 */
export const discoveredStale = (
  provider: string,
  maxAgeMs: number,
  now = Date.now(),
) => {
  const seen = (current.discovered[provider] ?? []).map(
    ({ observedAt }) => observedAt ?? 0,
  );
  return seen.length === 0 || now - Math.max(...seen) >= maxAgeMs;
};

/** The part of an id that names its family: everything before its first digit. */
const familyStem = (id: string) => {
  const digit = id.search(/\d/);
  return digit < 0 ? id : id.slice(0, digit);
};

const commonPrefix = (left: string, right: string) => {
  let length = 0;
  while (length < left.length && left[length] === right[length]) length += 1;
  return length;
};

/**
 * The pi model whose wire traits a newly observed model borrows: the model
 * of the same family (`gemini-`, `claude-fable-`, `anthropic/claude-`)
 * sharing the longest id prefix. Undefined when pi serves no model of that
 * family on the provider: dx then has nothing proven to call it with.
 */
export const templateFor = (
  models: ReadonlyArray<Model<Api>>,
  id: string,
): Model<Api> | undefined => {
  const stem = familyStem(id);
  if (stem.length < 2) return undefined;
  let best: Model<Api> | undefined;
  let bestLength = -1;
  for (const model of models) {
    if (!model.id.startsWith(stem)) continue;
    const length = commonPrefix(model.id, id);
    if (length > bestLength) {
      best = model;
      bestLength = length;
    }
  }
  return best;
};

/** An observed model served the way its template is. */
export const modelFromTemplate = (
  template: Model<Api>,
  observed: ObservedModel,
): Model<Api> => ({
  ...template,
  id: observed.id,
  name: observed.name ?? observed.id,
  cost: observed.cost ?? template.cost,
  contextWindow: observed.contextWindow ?? template.contextWindow,
  maxTokens: observed.maxTokens ?? template.maxTokens,
  reasoning: observed.reasoning ?? template.reasoning,
  input:
    observed.vision === undefined
      ? template.input
      : observed.vision
        ? ["text", "image"]
        : ["text"],
});

/**
 * Observations of the same model from several sources, the first source's
 * fields winning. Live provider data comes first: it describes what this
 * provider actually serves.
 */
export const mergeObserved = (
  ...sources: ReadonlyArray<ReadonlyArray<ObservedModel> | undefined>
): ReadonlyArray<ObservedModel> => {
  const merged = new Map<string, ObservedModel>();
  for (const source of sources)
    for (const model of source ?? []) {
      const known = merged.get(model.id) as Record<string, unknown> | undefined;
      if (known === undefined) {
        merged.set(model.id, model);
        continue;
      }
      const next: Record<string, unknown> = { ...known };
      for (const [key, value] of Object.entries(model))
        if (next[key] === undefined) next[key] = value;
      merged.set(model.id, next as unknown as ObservedModel);
    }
  return [...merged.values()];
};

/**
 * A pi provider's models with every observed model pi does not list yet,
 * each placed just before the model it borrows its wire traits from. pi's
 * own entry wins once a pi upgrade lists the same id.
 */
export const withObservedModels = (
  piModels: ReadonlyArray<Model<Api>>,
  observed: ReadonlyArray<ObservedModel>,
): Array<Model<Api>> => {
  const known = new Set(piModels.map(({ id }) => id));
  const before = new Map<string, Model<Api>[]>();
  for (const model of observed) {
    if (known.has(model.id)) continue;
    const template = templateFor(piModels, model.id);
    if (template === undefined) continue;
    known.add(model.id);
    before.set(template.id, [
      ...(before.get(template.id) ?? []),
      modelFromTemplate(template, model),
    ]);
  }
  return piModels.flatMap((model) => [...(before.get(model.id) ?? []), model]);
};

/**
 * Whether models.dev's id scheme for a provider is pi's. Some providers
 * (Cloudflare AI Gateway) prefix ids differently there; those keep pi's
 * list, since their models.dev ids would not reach the right upstream.
 */
export const sharesIdScheme = (
  piModels: ReadonlyArray<Model<Api>>,
  observed: ReadonlyArray<ObservedModel>,
) => {
  const ids = new Set(observed.map(({ id }) => id));
  return piModels.some(({ id }) => ids.has(id));
};

/**
 * A pi provider's pinned models plus the models observed at runtime that pi
 * does not list yet: what the provider itself reported, then models.dev.
 */
const providerModelsCache = new Map<string, ReadonlyArray<Model<Api>>>();
let providerModelsRevision = "";

export const runtimeProviderModels = (
  piProviderId: string,
): ReadonlyArray<Model<Api>> => {
  const { modelsDev, discovered, revision } = liveCatalog();
  if (revision !== providerModelsRevision) {
    providerModelsCache.clear();
    providerModelsRevision = revision;
  }
  const cached = providerModelsCache.get(piProviderId);
  if (cached !== undefined) return cached;
  const pinned = getBuiltinModels(
    piProviderId as Parameters<typeof getBuiltinModels>[0],
  );
  const published = modelsDev[piProviderId];
  const observed = mergeObserved(
    discovered[piProviderId],
    published !== undefined && sharesIdScheme(pinned, published)
      ? published
      : undefined,
  );
  const models = Object.freeze(
    observed.length === 0 ? [...pinned] : withObservedModels(pinned, observed),
  );
  providerModelsCache.set(piProviderId, models);
  return models;
};
