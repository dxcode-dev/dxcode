import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { orbProvidersLogger } from "../../logging.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import { isLocalRuntime } from "../registry.js";
import {
  decryptOrbCredentials,
  findConnection,
  type OrbConnection,
  type OrbConnectionKey,
  type OrbServedVersion,
  recordPreparation,
  restartPreparationRecord,
} from "./connections-d1.js";
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  type OrbProviderConnectors,
  OrbProviderCredentialsRejected,
} from "./connector.js";
import type { OrbProviderPreparationObject } from "./preparation-object.js";

/** Wait after a step the provider did not answer, before trying again. */
export const TRANSIENT_RETRY_MS = 30_000;
/** Consecutive unanswered steps (about ten minutes) before giving up. */
const MAX_TRANSIENT_FAILURES = 20;
/** A connection that stays this long without a step is stuck. */
export const PREPARATION_STALL_MS = 2 * 60_000;
const DEFAULT_STEP_MS = 10_000;

/**
 * Whether a connection can start Threads under this build's recipe. A
 * connection prepared for another recipe is preparing again.
 */
export const connectionStatus = (
  connection: Pick<OrbConnection, "recipe" | "status">,
  recipe: string,
): OrbPreparation["status"] =>
  connection.recipe === recipe ? connection.status : "preparing";

/**
 * The version new Threads use while `connection` is not ready for this
 * build: its last ready preparation (a connection ready for an older
 * recipe is that version itself), until the new one is ready. Null when it
 * was never ready.
 */
export const servedVersion = (
  connection: Pick<OrbConnection, "status" | "state" | "account" | "served">,
  connector: Pick<OrbProviderConnector, "targets" | "unavailable">,
): OrbServedVersion | null => {
  if (connection.status === "ready" && connection.account !== null) {
    const targets = connector.targets(connection);
    const unavailable = connector.unavailable?.(connection);
    if (targets !== undefined)
      return {
        account: connection.account,
        targets: Object.fromEntries(targets),
        ...(unavailable === undefined || unavailable.size === 0
          ? {}
          : { unavailable: Object.fromEntries(unavailable) }),
      };
  }
  return connection.served;
};

/**
 * A ready connection whose account could not run every size is prepared
 * again this long after its last preparation, so an upgraded plan gains its
 * sizes without the person saving their key again.
 */
export const SIZE_RECHECK_MS = 24 * 60 * 60_000;

/** The connection is ready, and its account cannot run some sizes. */
export const lacksSizes = (
  connection: Pick<OrbConnection, "status" | "state">,
  connector: Pick<OrbProviderConnector, "unavailable">,
) =>
  connection.status === "ready" &&
  (connector.unavailable?.(connection)?.size ?? 0) > 0;

/**
 * Prepares a ready or failed connection again from the start (its
 * connector reuses what the account already has), while new Threads keep
 * the version it served. False when another write won.
 */
export const restartPreparation = (
  db: D1Database,
  connection: OrbConnection,
  connector: Pick<OrbProviderConnector, "targets" | "unavailable">,
) =>
  restartPreparationRecord(
    db,
    connection,
    servedVersion(connection, connector),
    new Date().toISOString(),
  );

export interface PreparationStepOutcome {
  /** How long to wait before the next step; undefined when done. */
  readonly nextStepInMs: number | undefined;
  /** The provider did not answer this step. */
  readonly transient: boolean;
}

const done: PreparationStepOutcome = {
  nextStepInMs: undefined,
  transient: false,
};

/**
 * Runs one preparation step for a connection and records it, guarded by
 * the connection's revision so a save or removal in between wins. A step
 * the provider does not answer is retried; after `MAX_TRANSIENT_FAILURES`
 * in a row the connection fails.
 */
export const advanceConnection = async (
  bindings: Bindings,
  db: D1Database,
  key: OrbConnectionKey,
  connectors: OrbProviderConnectors,
  transientFailures = 0,
): Promise<PreparationStepOutcome> => {
  const connector = connectors[key.providerId];
  const found = await findConnection(db, key);
  if (connector === undefined || found === undefined) return done;
  const { connection } = found;
  const recipe = await connector.recipe();
  const restart = connection.recipe !== recipe;
  if (!restart && connection.status !== "preparing") return done;
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const credentials = await decryptOrbCredentials(keyring, found.stored);
  let next: OrbPreparation;
  let transient = false;
  try {
    next = restart
      ? await connector.start(credentials, recipe)
      : await connector.advance(credentials, recipe, connection);
  } catch (cause) {
    if (cause instanceof OrbProviderCredentialsRejected)
      next = failedPreparation(connection, cause.message);
    else {
      orbProvidersLogger.warn("Orb provider preparation step failed.", {
        event: "orb_preparation_step_failed",
        scope: key.scope,
        provider: key.providerId,
        error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
      });
      if (transientFailures + 1 < MAX_TRANSIENT_FAILURES)
        return { nextStepInMs: TRANSIENT_RETRY_MS, transient: true };
      transient = true;
      next = failedPreparation(
        connection,
        "The provider stopped responding while dx prepared this account. Retry to continue.",
      );
    }
  }
  const recorded = await recordPreparation(
    db,
    connection,
    recipe,
    // The account never changes within one configuration.
    { ...next, account: next.account ?? connection.account },
    new Date().toISOString(),
    // New Threads keep the last ready version until this one is ready.
    next.status === "ready" ? null : servedVersion(connection, connector),
  );
  orbProvidersLogger.info("Orb provider preparation advanced.", {
    event: "orb_preparation_advanced",
    scope: key.scope,
    provider: key.providerId,
    status: next.status,
    recorded,
  });
  // A save or another step won; read the connection again.
  if (!recorded) return { nextStepInMs: DEFAULT_STEP_MS, transient: false };
  return {
    nextStepInMs:
      next.status === "preparing"
        ? (next.nextStepInMs ?? DEFAULT_STEP_MS)
        : undefined,
    transient,
  };
};

const objectName = (key: OrbConnectionKey) =>
  `${key.scope}:${key.targetId}:${key.providerId}`;

/**
 * Starts (or resumes) a connection's preparation in its own object. The
 * local runtime never reaches a provider, so it prepares nothing.
 */
export const schedulePreparation = async (
  bindings: Bindings,
  key: OrbConnectionKey,
) => {
  if (isLocalRuntime(bindings)) return;
  const namespace = bindings.ORB_PROVIDER_PREPARATION as
    | DurableObjectNamespace<OrbProviderPreparationObject>
    | undefined;
  if (namespace === undefined) {
    orbProvidersLogger.error("Orb provider preparation is not deployed.", {
      event: "orb_preparation_unavailable",
      provider: key.providerId,
    });
    return;
  }
  await namespace.get(namespace.idFromName(objectName(key))).prepare(key);
};
