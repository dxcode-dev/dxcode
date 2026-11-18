import { findOrbProvider, type OrbProviderCredentials } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { orbProvidersLogger } from "../../logging.js";
import { isLocalRuntime } from "../registry.js";
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  type OrbProviderConnectors,
  OrbProviderCredentialsRejected,
} from "./connector.js";
import type { PreparationStepOutcome } from "./preparation.js";
import type { OrbProviderPreparationObject } from "./preparation-object.js";
import type { ExecutionProviderId } from "./provider.js";

/**
 * A provider the deployment installs on its own account and prepares at
 * runtime, as people's connections are prepared (`deployment.prepared`,
 * Boat with BOAT_API_KEY). One preparation serves every person's Threads;
 * it lives in `orb_deployment_preparation`, which holds no credential. The
 * key stays in the Worker's bindings.
 */

/** Wait after a step the provider did not answer, before trying again. */
const TRANSIENT_RETRY_MS = 30_000;
/** Consecutive unanswered steps before the preparation fails. */
const MAX_TRANSIENT_FAILURES = 20;
const DEFAULT_STEP_MS = 10_000;

/** The deployment secret of a provider prepared at runtime, if any. */
const preparedSecret = (providerId: string) => {
  const deployment = findOrbProvider(providerId)?.deployment;
  return deployment !== undefined &&
    "prepared" in deployment &&
    deployment.prepared
    ? deployment.secret
    : undefined;
};

/** Whether the deployment's account of `providerId` is prepared at runtime. */
export const deploymentPrepared = (providerId: string) =>
  preparedSecret(providerId) !== undefined;

/** The deployment's credentials for a prepared provider; never returned. */
const deploymentCredentials = (
  bindings: Bindings,
  providerId: string,
): OrbProviderCredentials | undefined => {
  const secret = preparedSecret(providerId);
  const apiKey = secret === undefined ? "" : (bindings[secret] ?? "").trim();
  return apiKey === "" ? undefined : { apiKey };
};

export interface DeploymentPreparation extends OrbPreparation {
  readonly recipe: string | null;
  readonly revision: number;
  /** The targets new Threads keep while a new recipe prepares. */
  readonly served: Readonly<Record<string, string>> | null;
}

interface Row {
  readonly recipe: string | null;
  readonly account: string | null;
  readonly status: OrbPreparation["status"];
  readonly state_json: string;
  readonly progress_json: string | null;
  readonly error: string | null;
  readonly revision: number;
}

const SERVED_KEY = "$served";

export const findDeploymentPreparation = async (
  db: D1Database,
  providerId: string,
): Promise<DeploymentPreparation | undefined> => {
  const row = await db
    .prepare(
      `SELECT recipe, account, status, state_json, progress_json, error, revision
         FROM orb_deployment_preparation WHERE provider_id = ?`,
    )
    .bind(providerId)
    .first<Row>();
  if (row === null) return undefined;
  const { [SERVED_KEY]: served, ...state } = JSON.parse(
    row.state_json,
  ) as Record<string, unknown>;
  return {
    recipe: row.recipe,
    account: row.account,
    status: row.status,
    state,
    progress: row.progress_json === null ? null : JSON.parse(row.progress_json),
    error: row.error,
    revision: row.revision,
    served:
      typeof served === "object" && served !== null
        ? (served as Record<string, string>)
        : null,
  };
};

/** Records a step unless another one won since `revision`. */
const record = async (
  db: D1Database,
  providerId: string,
  revision: number | undefined,
  recipe: string,
  next: OrbPreparation,
  served: Readonly<Record<string, string>> | null,
) => {
  const state = JSON.stringify({
    ...next.state,
    ...(served === null ? {} : { [SERVED_KEY]: served }),
  });
  const values = [
    recipe,
    next.account,
    next.status,
    state,
    next.progress === null ? null : JSON.stringify(next.progress),
    next.error,
    new Date().toISOString(),
  ];
  const result =
    revision === undefined
      ? await db
          .prepare(
            `INSERT OR IGNORE INTO orb_deployment_preparation
               (recipe, account, status, state_json, progress_json, error,
                updated_at, provider_id)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .bind(...values, providerId)
          .run()
      : await db
          .prepare(
            `UPDATE orb_deployment_preparation
                SET recipe = ?, account = ?, status = ?, state_json = ?,
                    progress_json = ?, error = ?, updated_at = ?,
                    revision = revision + 1
              WHERE provider_id = ? AND revision = ?`,
          )
          .bind(...values, providerId, revision)
          .run();
  return result.meta.changes === 1;
};

const targetsOf = (
  connector: OrbProviderConnector,
  preparation: Pick<OrbPreparation, "status" | "state">,
) => {
  const targets = connector.targets(preparation);
  return targets === undefined ? null : Object.fromEntries(targets);
};

/**
 * Runs one preparation step for the deployment's account of `providerId`
 * and records it. A new recipe prepares again from the start while new
 * Threads keep the last ready targets.
 */
export const advanceDeploymentPreparation = async (
  bindings: Bindings,
  db: D1Database,
  providerId: ExecutionProviderId,
  connectors: OrbProviderConnectors,
  transientFailures = 0,
): Promise<PreparationStepOutcome> => {
  const connector = connectors[providerId];
  const credentials = deploymentCredentials(bindings, providerId);
  const done = { nextStepInMs: undefined, transient: false };
  if (connector === undefined || credentials === undefined) return done;
  const recipe = await connector.recipe();
  const current = await findDeploymentPreparation(db, providerId);
  const restart = current === undefined || current.recipe !== recipe;
  if (!restart && current.status !== "preparing") return done;
  let next: OrbPreparation;
  let transient = false;
  try {
    next = restart
      ? await connector.start(credentials, recipe)
      : await connector.advance(credentials, recipe, current);
  } catch (cause) {
    const base = current ?? { account: null, state: {} };
    if (cause instanceof OrbProviderCredentialsRejected)
      next = failedPreparation(base, cause.message);
    else {
      orbProvidersLogger.warn("Deployment Orb preparation step failed.", {
        event: "orb_deployment_preparation_step_failed",
        provider: providerId,
        error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
      });
      if (transientFailures + 1 < MAX_TRANSIENT_FAILURES)
        return { nextStepInMs: TRANSIENT_RETRY_MS, transient: true };
      transient = true;
      next = failedPreparation(
        base,
        "The provider stopped responding while dx prepared the deployment's account.",
      );
    }
  }
  const served =
    next.status === "ready"
      ? null
      : current !== undefined && current.status === "ready"
        ? targetsOf(connector, current)
        : (current?.served ?? null);
  const recorded = await record(
    db,
    providerId,
    current?.revision,
    recipe,
    { ...next, account: next.account ?? current?.account ?? null },
    served,
  );
  orbProvidersLogger.info("Deployment Orb preparation advanced.", {
    event: "orb_deployment_preparation_advanced",
    provider: providerId,
    status: next.status,
    recorded,
  });
  if (!recorded) return { nextStepInMs: DEFAULT_STEP_MS, transient: false };
  return {
    nextStepInMs:
      next.status === "preparing"
        ? (next.nextStepInMs ?? DEFAULT_STEP_MS)
        : undefined,
    transient,
  };
};

/**
 * What the deployment's account of `providerId` serves new Threads now:
 * its targets by size and the sizes it cannot run, or its status while it
 * has none.
 */
export const deploymentTargets = async (
  db: D1Database,
  providerId: string,
  connector: OrbProviderConnector,
): Promise<
  | {
      readonly status: "ready";
      readonly account: string | null;
      readonly targets: Readonly<Record<string, string>>;
      readonly unavailable: ReadonlyMap<string, string>;
    }
  | { readonly status: "preparing" | "failed" }
> => {
  const preparation = await findDeploymentPreparation(db, providerId);
  if (preparation === undefined) return { status: "preparing" };
  const recipe = await connector.recipe();
  if (preparation.recipe === recipe && preparation.status === "ready") {
    const targets = targetsOf(connector, preparation);
    if (targets !== null)
      return {
        status: "ready",
        account: preparation.account,
        targets,
        unavailable: connector.unavailable?.(preparation) ?? new Map(),
      };
  }
  if (preparation.served !== null)
    return {
      status: "ready",
      account: preparation.account,
      targets: preparation.served,
      unavailable: new Map(),
    };
  return {
    status:
      preparation.recipe === recipe && preparation.status === "failed"
        ? "failed"
        : "preparing",
  };
};

/** The preparation object's name for a deployment's account. */
export const deploymentPreparationObjectName = (providerId: string) =>
  `deployment:${providerId}`;

/** Starts (or resumes) the deployment's preparation of `providerId`. */
export const scheduleDeploymentPreparation = async (
  bindings: Bindings,
  providerId: ExecutionProviderId,
) => {
  if (isLocalRuntime(bindings)) return;
  if (deploymentCredentials(bindings, providerId) === undefined) return;
  const namespace = bindings.ORB_PROVIDER_PREPARATION as
    | DurableObjectNamespace<OrbProviderPreparationObject>
    | undefined;
  if (namespace === undefined) {
    orbProvidersLogger.error("Orb provider preparation is not deployed.", {
      event: "orb_preparation_unavailable",
      provider: providerId,
    });
    return;
  }
  await namespace
    .get(namespace.idFromName(deploymentPreparationObjectName(providerId)))
    .prepareDeployment(providerId);
};
