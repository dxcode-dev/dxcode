import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../settings/integrations/credential-vault.js";
import { loadBitbucketConfiguration } from "./configuration.js";
import { createBitbucketProvider } from "./provider-http.js";
import {
  type BitbucketRenewer,
  createBitbucketRenewal,
  memoryRenewalJournals,
  RENEW_BEFORE_MS,
  type RenewalJournal,
  type RenewalOutcome,
  serializedRenewer,
} from "./token-renewal.js";

/** The renewal for one connection, built from a deployment's bindings. */
export const renewalFor = async (
  bindings: Bindings,
  db: D1Database,
  journalFor: (connectionId: string) => RenewalJournal,
  fetcher?: typeof fetch,
) => {
  const config = await Effect.runPromise(loadBitbucketConfiguration(bindings));
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  return createBitbucketRenewal({
    db,
    keyring,
    vault,
    provider: createBitbucketProvider(config, fetcher),
    journalFor,
  });
};

const inProcess = new WeakMap<D1Database, BitbucketRenewer>();

/**
 * Who renews a connection's tokens: its Durable Object where the deployment
 * binds one, otherwise this isolate, one renewal per connection at a time.
 */
export const bitbucketRenewerFor = (
  bindings: Bindings,
  db: D1Database,
  fetcher?: typeof fetch,
): BitbucketRenewer => {
  const namespace = bindings.BITBUCKET_TOKEN_COORDINATOR;
  if (namespace !== undefined && fetcher === undefined)
    return {
      renew: (request) =>
        namespace
          .get(namespace.idFromName(request.connectionId))
          .renew(request) as Promise<RenewalOutcome>,
    };
  const cached = fetcher === undefined ? inProcess.get(db) : undefined;
  if (cached !== undefined) return cached;
  const journals = memoryRenewalJournals();
  const renewer = serializedRenewer(() => ({
    renew: async (request) =>
      (await renewalFor(bindings, db, journals, fetcher)).renew(request),
  }));
  if (fetcher === undefined) inProcess.set(db, renewer);
  return renewer;
};

const SWEEP_LIMIT = 50;
const SWEEP_CONCURRENCY = 5;

/**
 * The cron's part: every active connection whose renewal is due is renewed,
 * whether or not anyone is using dx. Due means 30 minutes or less before the
 * access token expires, or a retry time after a failure has passed.
 */
export const sweepBitbucketRenewals = async (
  bindings: Bindings,
  scheduledTime: number,
) => {
  const db = bindings.DB;
  if (
    db === undefined ||
    bindings.DX_RUNTIME_MODE === "local" ||
    !bindings.DX_INTEGRATION_BITBUCKET_OAUTH?.trim() ||
    bindings.DX_INTEGRATION_BITBUCKET_OAUTH.trim() === "{}"
  )
    return;
  const due = await db
    .prepare(
      `SELECT id, user_id FROM bitbucket_connection
        WHERE status = 'active'
          AND (next_renewal_at <= ?1 OR expires_at IS NULL OR expires_at <= ?2)
        ORDER BY COALESCE(next_renewal_at, expires_at)
        LIMIT ${SWEEP_LIMIT}`,
    )
    .bind(
      new Date(scheduledTime).toISOString(),
      new Date(scheduledTime + RENEW_BEFORE_MS).toISOString(),
    )
    .all<{ id: string; user_id: string }>();
  if (due.results.length === 0) return;
  const renewer = bitbucketRenewerFor(bindings, db);
  const outcomes: Array<RenewalOutcome["outcome"]> = [];
  const queue = [...due.results];
  await Promise.all(
    Array.from({ length: SWEEP_CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await renewer
          .renew({
            connectionId: next.id,
            userId: next.user_id,
            trigger: "schedule",
          })
          .catch((): RenewalOutcome => ({ outcome: "unavailable" }));
        outcomes.push(result.outcome);
      }
    }),
  );
  sourceControlLogger.info("Bitbucket renewal sweep settled.", {
    event: "bitbucket_token_renewal_sweep",
    due: due.results.length,
    renewed: outcomes.filter((outcome) => outcome === "renewed").length,
    current: outcomes.filter((outcome) => outcome === "current").length,
    failed: outcomes.filter(
      (outcome) => outcome === "unavailable" || outcome === "rate-limited",
    ).length,
    reauthorizationRequired: outcomes.filter(
      (outcome) => outcome === "reauthorization-required",
    ).length,
  });
};
