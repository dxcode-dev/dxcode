import { Effect } from "effect";
import type { Bindings } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../settings/integrations/credential-vault.js";
import { loadGitHubAppConfiguration } from "./configuration.js";
import { createGitHubProvider } from "./provider-http.js";
import {
  createGitHubRenewal,
  type GitHubRenewer,
  memoryRenewalJournals,
  RENEW_BEFORE_MS,
  type RenewalJournal,
  type RenewalOutcome,
  serializedRenewer,
} from "./token-renewal.js";

/** The renewal for one authorization, built from a deployment's bindings. */
export const renewalFor = async (
  bindings: Bindings,
  db: D1Database,
  journalFor: (authorizationId: string) => RenewalJournal,
  fetcher?: typeof fetch,
) => {
  const config = await Effect.runPromise(loadGitHubAppConfiguration(bindings));
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  return createGitHubRenewal({
    db,
    keyring,
    vault,
    provider: createGitHubProvider(config, fetcher),
    journalFor,
  });
};

const inProcess = new WeakMap<D1Database, GitHubRenewer>();

/**
 * Who renews an authorization's user token: its Durable Object where the
 * deployment binds one, otherwise this isolate, one renewal per
 * authorization at a time.
 */
export const githubRenewerFor = (
  bindings: Bindings,
  db: D1Database,
): GitHubRenewer => {
  const namespace = bindings.GITHUB_TOKEN_COORDINATOR;
  if (namespace !== undefined)
    return {
      renew: (request) =>
        namespace
          .get(namespace.idFromName(request.authorizationId))
          .renew(request) as Promise<RenewalOutcome>,
    };
  const cached = inProcess.get(db);
  if (cached !== undefined) return cached;
  const journals = memoryRenewalJournals();
  const renewer = serializedRenewer(() => ({
    renew: async (request) =>
      (await renewalFor(bindings, db, journals)).renew(request),
  }));
  inProcess.set(db, renewer);
  return renewer;
};

const SWEEP_LIMIT = 50;
const SWEEP_CONCURRENCY = 5;

/**
 * The cron's part: every active authorization whose renewal is due is
 * renewed, whether or not anyone is using dx. Due means an hour or less
 * before the access token expires, or a retry time after a failure has
 * passed.
 */
export const sweepGitHubRenewals = async (
  bindings: Bindings,
  scheduledTime: number,
) => {
  const db = bindings.DB;
  if (
    db === undefined ||
    bindings.DX_RUNTIME_MODE === "local" ||
    !bindings.DX_INTEGRATION_GITHUB_APP?.trim()
  )
    return;
  const due = await db
    .prepare(
      `SELECT id, user_id FROM github_user_authorization
        WHERE status = 'active'
          AND refresh_token_reference_id IS NOT NULL
          AND expires_at IS NOT NULL
          AND ((next_renewal_at IS NOT NULL AND next_renewal_at <= ?1)
               OR (next_renewal_at IS NULL AND expires_at <= ?2))
        ORDER BY COALESCE(next_renewal_at, expires_at)
        LIMIT ${SWEEP_LIMIT}`,
    )
    .bind(
      new Date(scheduledTime).toISOString(),
      new Date(scheduledTime + RENEW_BEFORE_MS).toISOString(),
    )
    .all<{ id: string; user_id: string }>();
  if (due.results.length === 0) return;
  const renewer = githubRenewerFor(bindings, db);
  const outcomes: Array<RenewalOutcome["outcome"]> = [];
  const queue = [...due.results];
  await Promise.all(
    Array.from({ length: SWEEP_CONCURRENCY }, async () => {
      for (let next = queue.shift(); next; next = queue.shift()) {
        const result = await renewer
          .renew({
            authorizationId: next.id,
            userId: next.user_id,
            trigger: "schedule",
          })
          .catch((): RenewalOutcome => ({ outcome: "unavailable" }));
        outcomes.push(result.outcome);
      }
    }),
  );
  sourceControlLogger.info("GitHub renewal sweep settled.", {
    event: "github_token_renewal_sweep",
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
