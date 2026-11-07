import {
  type IntegrationOwner,
  integrationCredentialReferenceFor,
  SourceControlAccessDenied,
} from "@dx/domain";
import { Effect } from "effect";
import { sourceControlLogger } from "../../logging.js";
import type { ConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import {
  type IntegrationCredentialVaultShape,
  insertSealedIntegrationCredential,
  type SealedIntegrationCredential,
  sealIntegrationCredential,
} from "../../settings/integrations/credential-vault.js";
import {
  BitbucketProviderError,
  type createBitbucketProvider,
} from "./provider-http.js";

// Bitbucket refresh tokens are single-use (CHANGE-3052): each refresh
// returns a new one and kills the old one. A rotation whose answer dx loses
// ends the authorization. So renewal runs here, one at a time per
// connection, inside the connection's Durable Object (token-coordinator.ts),
// which keeps running when the request that asked goes away. The answer is
// journalled the moment it arrives and committed with its credentials in
// one D1 batch. Every connection is renewed on the cron 30 minutes before
// its access token expires, whether or not anyone uses it.

/** Renew this long before the access token expires (tokens last 2 h). */
export const RENEW_BEFORE_MS = 30 * 60_000;
/** Retry delays after consecutive failures; the last one repeats. */
/** No renewal is scheduled sooner than this after another. */
const MIN_RENEWAL_GAP_MS = 60_000;
const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];

export interface RenewalRequest {
  readonly connectionId: string;
  readonly userId: string;
  /** `use`: a request needs a token now. `schedule`: the cron. */
  readonly trigger: "use" | "schedule";
  /** The access credential Bitbucket just refused; renews even if unexpired. */
  readonly stale?: string;
}

export type RenewalOutcome =
  | { readonly outcome: "current" }
  | { readonly outcome: "renewed"; readonly verified: boolean }
  | { readonly outcome: "reauthorization-required" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "rate-limited"; readonly retryAt?: string };

interface ConnectionRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider_account_id: string;
  readonly status: string;
  readonly authorization_epoch: number;
  readonly access_credential_id: string | null;
  readonly refresh_credential_id: string | null;
  readonly expires_at: string | null;
  readonly next_renewal_at: string | null;
  readonly renewal_failures: number | null;
}

/** What survives the object being reset between Bitbucket's answer and D1. */
export type RenewalJournalEntry =
  | {
      readonly stage: "sent";
      readonly connectionId: string;
      readonly epoch: number;
      readonly at: string;
    }
  | {
      readonly stage: "answered";
      readonly connectionId: string;
      readonly userId: string;
      readonly epoch: number;
      readonly previousAccess: string | null;
      readonly previousRefresh: string;
      readonly access: SealedIntegrationCredential;
      readonly refresh: SealedIntegrationCredential;
      readonly expiresAt: string;
      readonly at: string;
    };

export interface RenewalJournal {
  readonly read: () => Promise<RenewalJournalEntry | undefined>;
  readonly write: (entry: RenewalJournalEntry) => Promise<void>;
  readonly clear: () => Promise<void>;
}

export const memoryRenewalJournal = (): RenewalJournal => {
  let entry: RenewalJournalEntry | undefined;
  return {
    read: async () => entry,
    write: async (next) => {
      entry = next;
    },
    clear: async () => {
      entry = undefined;
    },
  };
};

/** Journals kept in this isolate's memory, one per connection. */
export const memoryRenewalJournals = () => {
  const journals = new Map<string, RenewalJournal>();
  return (connectionId: string) => {
    let journal = journals.get(connectionId);
    if (journal === undefined) {
      journal = memoryRenewalJournal();
      journals.set(connectionId, journal);
    }
    return journal;
  };
};

export interface BitbucketRenewer {
  readonly renew: (request: RenewalRequest) => Promise<RenewalOutcome>;
}

const ownerOf = (userId: string): IntegrationOwner => ({
  scope: "personal",
  id: userId as never,
});
const iso = (ms: number) => new Date(ms).toISOString();
const categoryOf = (cause: unknown) =>
  cause instanceof BitbucketProviderError
    ? cause.category
    : cause instanceof SourceControlAccessDenied
      ? cause.reason
      : "internal";

export const createBitbucketRenewal = (input: {
  readonly db: D1Database;
  readonly keyring: ConfigEncryptionKeyring;
  readonly vault: IntegrationCredentialVaultShape;
  readonly provider: ReturnType<typeof createBitbucketProvider>;
  /** Where a connection's in-flight renewal survives a reset. */
  readonly journalFor: (connectionId: string) => RenewalJournal;
}): BitbucketRenewer => {
  const { db, keyring, vault, provider } = input;
  const readRow = (id: string) =>
    db
      .prepare("SELECT * FROM bitbucket_connection WHERE id = ?")
      .bind(id)
      .first<ConnectionRow>();
  const log = (
    connectionId: string,
    trigger: RenewalRequest["trigger"] | "recovery",
    outcome: "refreshed" | "retryable" | "refused",
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    const properties = {
      event: "bitbucket_token_refresh",
      connectionId,
      trigger,
      outcome,
      reason,
      ...extra,
    };
    if (outcome === "refreshed")
      sourceControlLogger.info("Bitbucket token refresh settled.", properties);
    else
      sourceControlLogger.warn("Bitbucket token refresh settled.", properties);
  };

  /** Records a failed renewal and when to try again. The grant stands. */
  const recordFailure = async (
    row: ConnectionRow,
    reason: string,
    retryAt?: Date,
  ) => {
    const failures = (row.renewal_failures ?? 0) + 1;
    const now = Date.now();
    const next =
      retryAt?.getTime() ??
      now + (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] as number);
    await db
      .prepare(
        "UPDATE bitbucket_connection SET renewal_failures = renewal_failures + 1, renewal_failing_since = COALESCE(renewal_failing_since, ?), last_renewal_error = ?, next_renewal_at = ?, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ?",
      )
      .bind(
        iso(now),
        reason.slice(0, 64),
        iso(next),
        iso(now),
        row.id,
        row.authorization_epoch,
      )
      .run()
      .catch(() => undefined);
    return iso(next);
  };

  /** Bitbucket ended the grant: ask the person to reconnect, once. */
  const endAuthorization = async (row: ConnectionRow, reason: string) => {
    const now = iso(Date.now());
    await db.batch([
      db
        .prepare(
          "DELETE FROM bitbucket_git_lease WHERE connection_id = ? AND authorization_epoch = ?",
        )
        .bind(row.id, row.authorization_epoch),
      db
        .prepare(
          "UPDATE bitbucket_connection SET status = 'reauthorization-required', authorization_epoch = authorization_epoch + 1, last_renewal_error = ?, renewal_failing_since = COALESCE(renewal_failing_since, ?), next_renewal_at = NULL, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ?",
        )
        .bind(reason.slice(0, 64), now, now, row.id, row.authorization_epoch),
    ]);
  };

  /**
   * Commits a journalled answer: both credentials, the connection's pointers
   * to them, and the removal of the ones they replace, in one D1 batch.
   * Replaying it is harmless. A connection that ended meanwhile keeps
   * nothing of it.
   */
  const commit = async (
    entry: Extract<RenewalJournalEntry, { stage: "answered" }>,
    verifiedAt: string | null,
  ) => {
    const row = await readRow(entry.connectionId);
    if (row?.refresh_credential_id === entry.refresh.id) return "committed";
    const nowMs = Date.now();
    const now = iso(nowMs);
    const owner = ownerOf(entry.userId);
    const failures = verifiedAt === null ? (row?.renewal_failures ?? 0) + 1 : 0;
    const next =
      verifiedAt === null
        ? nowMs +
          (BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] as number)
        : Date.parse(entry.expiresAt) - RENEW_BEFORE_MS;
    const results = await db.batch([
      insertSealedIntegrationCredential(db, owner, entry.access, now),
      insertSealedIntegrationCredential(db, owner, entry.refresh, now),
      db
        .prepare(
          "UPDATE bitbucket_connection SET access_credential_id = ?, refresh_credential_id = ?, expires_at = ?, next_renewal_at = ?, last_renewed_at = ?, last_verified_at = COALESCE(?, last_verified_at), renewal_failures = ?, renewal_failing_since = CASE WHEN ? IS NULL THEN COALESCE(renewal_failing_since, ?) ELSE NULL END, last_renewal_error = CASE WHEN ? IS NULL THEN 'verify' ELSE NULL END, refresh_lock_id = NULL, refresh_lock_until = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND authorization_epoch = ? AND refresh_credential_id = ?",
        )
        .bind(
          entry.access.id,
          entry.refresh.id,
          entry.expiresAt,
          iso(Math.max(next, nowMs + MIN_RENEWAL_GAP_MS)),
          now,
          verifiedAt,
          failures,
          verifiedAt,
          now,
          verifiedAt,
          now,
          entry.connectionId,
          entry.epoch,
          entry.previousRefresh,
        ),
      // The replaced credentials go once the connection points past them.
      db
        .prepare(
          "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (?, ?) AND EXISTS (SELECT 1 FROM bitbucket_connection WHERE id = ? AND refresh_credential_id = ?)",
        )
        .bind(
          entry.userId,
          entry.previousAccess ?? entry.previousRefresh,
          entry.previousRefresh,
          entry.connectionId,
          entry.refresh.id,
        ),
      // An answer for an authorization that ended meanwhile is dropped.
      db
        .prepare(
          "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (?, ?) AND NOT EXISTS (SELECT 1 FROM bitbucket_connection WHERE id = ? AND refresh_credential_id = ?)",
        )
        .bind(
          entry.userId,
          entry.access.id,
          entry.refresh.id,
          entry.connectionId,
          entry.refresh.id,
        ),
    ]);
    return results[2]?.meta.changes === 1 ? "committed" : "superseded";
  };

  /** Finishes whatever a reset interrupted, before anything else. */
  const recover = async (journal: RenewalJournal) => {
    const entry = await journal.read();
    if (entry === undefined) return;
    if (entry.stage === "answered") {
      // Bitbucket answered and the object was reset before D1 committed.
      // The journalled tokens are the only live ones: commit them.
      const result = await commit(entry, null);
      log(entry.connectionId, "recovery", "refreshed", `recovered-${result}`);
    } else {
      // The object was reset after sending and before any answer. Bitbucket
      // may have rotated; the next renewal finds out and, if it refuses,
      // honestly asks for a reconnect.
      log(entry.connectionId, "recovery", "retryable", "answer-lost");
    }
    await journal.clear();
  };

  const renewOnce = async (
    request: RenewalRequest,
  ): Promise<RenewalOutcome> => {
    const journal = input.journalFor(request.connectionId);
    await recover(journal);
    const row = await readRow(request.connectionId);
    if (
      row === null ||
      row.user_id !== request.userId ||
      row.status !== "active" ||
      row.refresh_credential_id === null
    )
      return { outcome: "reauthorization-required" };
    const now = Date.now();
    const stale =
      request.stale !== undefined && request.stale === row.access_credential_id;
    const expiresAt =
      row.expires_at === null ? 0 : Date.parse(row.expires_at) || 0;
    const due =
      stale ||
      expiresAt - now <= RENEW_BEFORE_MS ||
      (row.next_renewal_at !== null && Date.parse(row.next_renewal_at) <= now);
    // A request whose token is still good, and a cron tick that raced
    // another renewal, have nothing to do.
    if (
      !due ||
      (request.trigger === "use" && !stale && expiresAt - now > 60_000)
    )
      return { outcome: "current" };

    await journal.write({
      stage: "sent",
      connectionId: row.id,
      epoch: row.authorization_epoch,
      at: iso(now),
    });
    let tokens: Awaited<ReturnType<typeof provider.refreshToken>>;
    try {
      const refreshToken = await Effect.runPromise(
        vault.read(
          keyring,
          ownerOf(row.user_id),
          "refresh-token",
          integrationCredentialReferenceFor(row.refresh_credential_id as never),
        ),
      );
      tokens = await provider.refreshToken(refreshToken);
    } catch (cause) {
      await journal.clear();
      const code =
        cause instanceof BitbucketProviderError ? cause.code : undefined;
      if (
        cause instanceof BitbucketProviderError &&
        cause.category === "invalid-grant"
      ) {
        log(row.id, request.trigger, "refused", "invalid-grant", { code });
        await endAuthorization(row, "invalid_grant");
        return { outcome: "reauthorization-required" };
      }
      const reason = categoryOf(cause);
      const retryAt =
        cause instanceof BitbucketProviderError ? cause.retryAt : undefined;
      const nextRenewalAt = await recordFailure(row, code ?? reason, retryAt);
      log(row.id, request.trigger, "retryable", reason, {
        code,
        failures: (row.renewal_failures ?? 0) + 1,
        nextRenewalAt,
      });
      return reason === "rate-limited"
        ? {
            outcome: "rate-limited",
            ...(retryAt === undefined
              ? {}
              : { retryAt: retryAt.toISOString() }),
          }
        : { outcome: "unavailable" };
    }

    // From here the new tokens are the only live ones. Journal them first.
    const owner = ownerOf(row.user_id);
    const [access, refresh] = await Promise.all([
      Effect.runPromise(
        sealIntegrationCredential(
          keyring,
          owner,
          "access-token",
          tokens.accessToken,
        ),
      ),
      Effect.runPromise(
        sealIntegrationCredential(
          keyring,
          owner,
          "refresh-token",
          tokens.refreshToken,
        ),
      ),
    ]);
    const answered = {
      stage: "answered",
      connectionId: row.id,
      userId: row.user_id,
      epoch: row.authorization_epoch,
      previousAccess: row.access_credential_id,
      previousRefresh: row.refresh_credential_id,
      access,
      refresh,
      expiresAt: tokens.expiresAt.toISOString(),
      at: iso(Date.now()),
    } satisfies RenewalJournalEntry;
    await journal.write(answered);

    // Prove the new access token with an authenticated call before relying
    // on it. The rotation is committed either way: its refresh token is the
    // only one Bitbucket still accepts.
    let verifiedAt: string | null = null;
    let verifyError: string | undefined;
    let accountChanged = false;
    try {
      const user = await provider.getUser(tokens.accessToken);
      if (user.id === row.provider_account_id) verifiedAt = iso(Date.now());
      else accountChanged = true;
    } catch (cause) {
      verifyError = categoryOf(cause);
    }
    let result: "committed" | "superseded";
    try {
      result = await commit(answered, verifiedAt);
    } catch (cause) {
      // A batch is atomic: either it landed and only its acknowledgement was
      // lost, or nothing changed and the journal commits it next time.
      const settled = await readRow(row.id).catch(() => null);
      if (settled?.refresh_credential_id !== answered.refresh.id) throw cause;
      result = "committed";
    }
    await journal.clear();
    if (result === "superseded") {
      log(row.id, request.trigger, "retryable", "superseded");
      return { outcome: "reauthorization-required" };
    }
    if (accountChanged) {
      log(row.id, request.trigger, "refused", "account-changed");
      const current = await readRow(row.id);
      if (current !== null) await endAuthorization(current, "account_changed");
      return { outcome: "reauthorization-required" };
    }
    const committed = await readRow(row.id).catch(() => null);
    log(
      row.id,
      request.trigger,
      "refreshed",
      verifiedAt === null ? "unverified" : "verified",
      {
        verified: verifiedAt !== null,
        expiresAt: answered.expiresAt,
        nextRenewalAt: committed?.next_renewal_at ?? null,
        ...(verifyError === undefined ? {} : { verifyError }),
      },
    );
    return { outcome: "renewed", verified: verifiedAt !== null };
  };

  return {
    renew: async (request) => {
      try {
        return await renewOnce(request);
      } catch (cause) {
        // D1, the vault, or the journal failed. Whatever was journalled is
        // committed by the next renewal; the grant stands.
        sourceControlLogger.warn("Bitbucket token refresh settled.", {
          event: "bitbucket_token_refresh",
          connectionId: request.connectionId,
          trigger: request.trigger,
          outcome: "retryable",
          reason: `internal:${categoryOf(cause)}`,
        });
        return { outcome: "unavailable" };
      }
    },
  };
};

/**
 * Serializes renewals per connection within this isolate, for deployments
 * and tests without the coordinator binding.
 */
export const serializedRenewer = (
  renewer: (connectionId: string) => BitbucketRenewer,
): BitbucketRenewer => {
  const chains = new Map<string, Promise<unknown>>();
  return {
    renew: (request) => {
      const previous = chains.get(request.connectionId) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(() => renewer(request.connectionId).renew(request));
      const settled = run.catch(() => undefined);
      chains.set(request.connectionId, settled);
      void settled.then(() => {
        if (chains.get(request.connectionId) === settled)
          chains.delete(request.connectionId);
      });
      return run;
    },
  };
};
