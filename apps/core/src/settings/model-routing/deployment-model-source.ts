import type { ModeConfig, ModeId } from "@dx/domain";
import type {
  DeploymentUpstream,
  UpstreamModel,
} from "./deployment-upstreams.js";

/**
 * What a deployment's dx model configuration looks like to Core, and the
 * seam a deployment registers to supply it
 * (deployment-models-registration.ts). Public dx registers
 * `noDeploymentModels`.
 */

/** The provider people see every installation model under. */
export const DX_PROVIDER_ID = "dx" as const;

/** Where one upstream serves a dx alias. */
export interface DxModelRoute {
  /** The enabled upstream serving it, and that upstream's preset. */
  readonly upstreamId: string;
  readonly upstream: DeploymentUpstream;
  readonly upstreamModel: string;
  readonly capabilities: UpstreamModel;
  /** The wire API and endpoint the upstream serves this model at. */
  readonly api: DeploymentUpstream["api"];
  readonly baseUrl: string;
}

/** One model an upstream serves under a dx alias. */
export interface DxModel extends DxModelRoute {
  /** The dx alias; the canonical id is `dx/<alias>`. */
  readonly id: string;
  readonly name: string;
  /**
   * The alias's other serving upstreams, in priority order. A call the
   * serving upstream fails before answering (unreachable, rate-limited,
   * refused its key, a 5xx) goes to the next one with the same wire API.
   */
  readonly fallbacks?: ReadonlyArray<DxModelRoute>;
  /** USD per 1M tokens charged to the person. */
  readonly price: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  /** A new submission starts only while the balance is above this. */
  readonly minBalanceMicros: number;
}

/**
 * The most one call of a dx model can cost, in micro-dollars: a full context
 * window at its dearest input rate and a full reply. A fixed number per
 * model, so holding it needs no guess about the call.
 */
export const dxModelCallReserveMicros = (model: DxModel) =>
  Math.ceil(
    model.capabilities.contextWindow *
      Math.max(
        model.price.input,
        model.price.cacheRead,
        model.price.cacheWrite,
      ) +
      model.capabilities.maxTokens * model.price.output,
  );

/** An enabled, keyed upstream, in serving order. */
export interface DxUpstream {
  readonly id: string;
  readonly upstream: DeploymentUpstream;
  readonly priority: number;
  readonly baseUrl: string;
  /** The admin's values for the upstream's provider fields. */
  readonly fields?: Readonly<Record<string, string>>;
  /**
   * Headers sent with every request to the upstream. Only the credential
   * coordinator reads them; a person's view of a dx connection has none.
   */
  readonly headers?: ReadonlyArray<{
    readonly name: string;
    readonly value: string;
  }>;
}

export interface DeploymentModels {
  readonly upstreams: ReadonlyArray<DxUpstream>;
  /** One serving row per alias: the lowest-priority enabled one. */
  readonly models: ReadonlyArray<DxModel>;
  /**
   * Every alias the admin configured, served or not, with its dx name, so
   * a Thread on a model whose upstream is off still reads "dx Flash".
   */
  readonly names?: ReadonlyMap<string, string>;
  /** Mode defaults the admin set, by mode. */
  readonly modes: ReadonlyMap<ModeId, ModeConfig>;
  /** Why some of the configuration was ignored, for the admin. */
  readonly problems: ReadonlyArray<string>;
}

export const EMPTY_DEPLOYMENT_MODELS: DeploymentModels = {
  upstreams: [],
  models: [],
  modes: new Map(),
  problems: [],
};

/**
 * Where a deployment keeps its dx models. `load` is called on every route
 * and submission, so it caches; `upstreamKey` decrypts one upstream's key
 * and is called only from the credential coordinator.
 */
export interface DeploymentModelSource {
  readonly load: (db: D1Database | undefined) => Promise<DeploymentModels>;
  readonly upstreamKey: (
    db: D1Database,
    bindings: unknown,
    upstreamId: string,
  ) => Promise<string | undefined>;
}

export const noDeploymentModels: DeploymentModelSource = {
  load: async () => EMPTY_DEPLOYMENT_MODELS,
  upstreamKey: async () => undefined,
};
