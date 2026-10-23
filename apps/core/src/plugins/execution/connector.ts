import type {
  OrbProviderConnectionStatus,
  OrbProviderCredentials,
  OrbProviderField,
  OrbProviderPreparationProgress,
} from "@dx/domain";
import type { ExecutionProviderId } from "./provider.js";

/**
 * How a provider joins a person's or workspace's own account
 * (tasks/orb-provider-connections.md). The connection form asks for
 * `fields`. Saving runs `start`, which verifies the credentials in the save
 * request. The preparation object then runs `advance` until the account is
 * `ready`, and the provider's sizes open in the Orb picker. A provider
 * without a connector runs only on the deployment's own account.
 */
export interface OrbProviderConnector {
  readonly providerId: ExecutionProviderId;
  /** One sentence on the settings page: what connecting takes. */
  readonly description: string;
  readonly fields: ReadonlyArray<OrbProviderField>;
  /**
   * Credentials dx makes rather than asks for (the Cloudflare Orb Worker's
   * name and secret), by ID. They are made on a connection's first save
   * and kept when it is saved again, so pinned Threads keep reaching what
   * preparation made.
   */
  readonly generatedFields?: Readonly<Record<string, () => string>>;
  /**
   * This build's preparation recipe. A connection prepared for another
   * recipe is prepared again before new Threads start on it; pinned Threads
   * keep the targets they pinned.
   */
  readonly recipe: () => Promise<string>;
  /**
   * Verifies the credentials and starts preparation. It runs in the save
   * request, so it is quick. It rejects with
   * `OrbProviderCredentialsRejected` when the provider refuses them.
   */
  readonly start: (
    credentials: OrbProviderCredentials,
    recipe: string,
  ) => Promise<OrbPreparation>;
  /** One preparation step after `current`, which is still preparing. */
  readonly advance: (
    credentials: OrbProviderCredentials,
    recipe: string,
    current: OrbPreparation,
  ) => Promise<OrbPreparation>;
  /**
   * What each size's Threads pin once the connection is ready, by runner
   * profile ID: E2B's template built into the team, or the Cloudflare
   * account's Orb Worker URL. Target resolution applies a pinned target
   * (runner-profiles/execution.ts), so a pinned Thread never depends on its
   * connector.
   */
  readonly targets: (
    preparation: Pick<OrbPreparation, "status" | "state">,
  ) => ReadonlyMap<string, string> | undefined;
}

export type OrbProviderConnectors = Readonly<
  Partial<Record<ExecutionProviderId, OrbProviderConnector>>
>;

/** Where a connection's preparation stands after one step. */
export interface OrbPreparation {
  readonly status: OrbProviderConnectionStatus;
  /** The provider account the credentials belong to, once known. */
  readonly account: string | null;
  /** The provider's own JSON state, passed back to the next step. */
  readonly state: OrbPreparationState;
  readonly progress: OrbProviderPreparationProgress | null;
  readonly error: string | null;
  /** How long to wait before the next step; only while preparing. */
  readonly nextStepInMs?: number;
}

export type OrbPreparationState = Readonly<Record<string, unknown>>;

/** The provider refused the credentials; `detail` says what to fix. */
export class OrbProviderCredentialsRejected extends Error {
  constructor(readonly detail?: string) {
    super(detail ?? "The provider rejected these credentials.");
  }
}

/** A preparation that failed with `error`, keeping what it had. */
export const failedPreparation = (
  current: Pick<OrbPreparation, "account" | "state">,
  error: string,
): OrbPreparation => ({
  status: "failed",
  account: current.account,
  state: current.state,
  progress: null,
  error: error.slice(0, 500),
});
