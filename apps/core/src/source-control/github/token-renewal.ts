import {
  type IntegrationOwner,
  integrationCredentialReferenceFor,
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
  type createGitHubProvider,
  GitHubProviderError,
} from "./provider-http.js";

// GitHub App user tokens rotate: "Once you use a refresh token, that refresh
// token and the old user access token will no longer work." A rotation whose
// answer dx loses ends the authorization, as it did for Bitbucket (#1952).
// So renewal runs here, one at a time per authorization, inside the
// authorization's Durable Object (token-coordinator.ts), which keeps running
// when the request that asked goes away. The answer is journalled the moment
// it arrives and committed with its credentials in one D1 batch. Every
// authorization is renewed on the cron an hour before its 8-hour access token
// expires, whether or not anyone uses it (#1953).

/** Renew this long before the access token expires (tokens last 8 h). */
export const RENEW_BEFORE_MS = 60 * 60_000;
/** No renewal is scheduled sooner than this after another. */
const MIN_RENEWAL_GAP_MS = 60_000;
/** Retry delays after consecutive failures; the last one repeats. */
const BACKOFF_MS = [60_000, 2 * 60_000, 5 * 60_000, 10 * 60_000, 15 * 60_000];

export interface RenewalRequest {
  readonly authorizationId: string;
  readonly userId: string;
  /** `use`: a request needs a token now. `schedule`: the cron. */
  readonly trigger: "use" | "schedule";
}

export type RenewalOutcome =
  | { readonly outcome: "current" }
  | { readonly outcome: "renewed"; readonly verified: boolean }
  | { readonly outcome: "reauthorization-required" }
  | { readonly outcome: "unavailable" }
  | { readonly outcome: "rate-limited"; readonly retryAt?: string };

interface AuthorizationRow {
  readonly id: string;
  readonly user_id: string;
  readonly provider_account_id: string;
  readonly status: string;
  readonly access_token_reference_id: string | null;
  readonly refresh_token_reference_id: string | null;
  readonly expires_at: string | null;
  readonly next_renewal_at: string | null;
  readonly renewal_failures: number | null;
}

/** What survives the object being reset between GitHub's answer and D1. */
export type RenewalJournalEntry =
  | {
      readonly stage: "sent";
      readonly authorizationId: string;
      readonly at: string;
    }
  | {
      readonly stage: "answered";
      readonly authorizationId: string;
      readonly userId: string;
      readonly previousAccess: string | null;
      readonly previousRefresh: string;
      readonly access: SealedIntegrationCredential;
      readonly refresh: SealedIntegrationCredential;
      readonly expiresAt: string;
      readonly refreshExpiresAt: string | null;
      readonly at: string;
    };

export interface RenewalJournal {
  readonly read: () => Promise<RenewalJournalEntry | undefined>;
  readonly write: (entry: RenewalJournalEntry) => Promise<void>;
  readonly clear: () => Promise<void>;
}

/** Journals kept in this isolate's memory, one per authorization. */
export const memoryRenewalJournals = () => {
  const journals = new Map<string, RenewalJournal>();
  return (authorizationId: string) => {
    let journal = journals.get(authorizationId);
    if (journal === undefined) {
      let entry: RenewalJournalEntry | undefined;
      journal = {
        read: async () => entry,
        write: async (next) => {
          entry = next;
        },
        clear: async () => {
          entry = undefined;
        },
      };
      journals.set(authorizationId, journal);
    }
    return journal;
  };
};

export interface GitHubRenewer {
  readonly renew: (request: RenewalRequest) => Promise<RenewalOutcome>;
}

const ownerOf = (userId: string): IntegrationOwner => ({
  scope: "personal",
  id: userId as never,
});
const iso = (ms: number) => new Date(ms).toISOString();
const backoff = (failures: number) =>
  BACKOFF_MS[Math.min(failures, BACKOFF_MS.length) - 1] as number;
const categoryOf = (cause: unknown) =>
  cause instanceof GitHubProviderError ? cause.category : "internal";

export const createGitHubRenewal = (input: {
  readonly db: D1Database;
  readonly keyring: ConfigEncryptionKeyring;
  readonly vault: IntegrationCredentialVaultShape;
  readonly provider: Pick<
    ReturnType<typeof createGitHubProvider>,
    "refresh" | "getUser"
  >;
  /** Where an authorization's in-flight renewal survives a reset. */
  readonly journalFor: (authorizationId: string) => RenewalJournal;
}): GitHubRenewer => {
  const { db, keyring, vault, provider } = input;
  const readRow = (id: string) =>
    db
      .prepare("SELECT * FROM github_user_authorization WHERE id = ?")
      .bind(id)
      .first<AuthorizationRow>();
  const log = (
    authorizationId: string,
    trigger: RenewalRequest["trigger"] | "recovery",
    outcome: "refreshed" | "retryable" | "refused",
    reason: string,
    extra: Record<string, unknown> = {},
  ) => {
    const properties = {
      event: "github_user_token_refresh",
      authorizationId,
      trigger,
      outcome,
      reason,
      ...extra,
    };
    if (outcome === "refreshed")
      sourceControlLogger.info(
        "GitHub user token refresh settled.",
        properties,
      );
    else
      sourceControlLogger.warn(
        "GitHub user token refresh settled.",
        properties,
      );
  };

  /** Records a failed renewal and when to try again. The grant stands. */
  const recordFailure = async (
    row: AuthorizationRow,
    reason: string,
    retryAt?: Date,
  ) => {
    const now = Date.now();
    const next =
      retryAt?.getTime() ?? now + backoff((row.renewal_failures ?? 0) + 1);
    await db
      .prepare(
        "UPDATE github_user_authorization SET renewal_failures = renewal_failures + 1, renewal_failing_since = COALESCE(renewal_failing_since, ?), last_renewal_error = ?, next_renewal_at = ? WHERE id = ? AND status = 'active' AND refresh_token_reference_id = ?",
      )
      .bind(
        iso(now),
        reason.slice(0, 64),
        iso(next),
        row.id,
        row.refresh_token_reference_id,
      )
      .run()
      .catch(() => undefined);
    return iso(next);
  };

  /**
   * GitHub ended the grant: ask the person to reconnect, once. Only the
   * exact token pair GitHub refused is ended; a pair that changed meanwhile
   * (a reconnect) stands.
   */
  const endAuthorization = async (row: AuthorizationRow, reason: string) => {
    const now = iso(Date.now());
    const ended = await db.batch([
      db
        .prepare(
          "UPDATE github_user_authorization SET status = 'reauthorization-required', access_token_reference_id = NULL, refresh_token_reference_id = NULL, last_renewal_error = ?, renewal_failing_since = COALESCE(renewal_failing_since, ?), next_renewal_at = NULL, updated_at = ? WHERE id = ? AND status = 'active' AND refresh_token_reference_id = ? AND access_token_reference_id IS ?",
        )
        .bind(
          reason.slice(0, 64),
          now,
          now,
          row.id,
          row.refresh_token_reference_id,
          row.access_token_reference_id,
        ),
      db
        .prepare(`
          INSERT INTO github_authorization_epoch (subject_kind, subject_id, epoch, updated_at)
          SELECT 'user-authorization', ?1, 2, ?2
           WHERE EXISTS (SELECT 1 FROM github_user_authorization
                          WHERE id = ?1 AND status = 'reauthorization-required')
          ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
            epoch = epoch + 1, updated_at = excluded.updated_at
        `)
        .bind(row.id, now),
      // The refused pair is dead; drop it once nothing points at it.
      db
        .prepare(
          "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (?, ?) AND NOT EXISTS (SELECT 1 FROM github_user_authorization WHERE access_token_reference_id = integration_credential.id OR refresh_token_reference_id = integration_credential.id)",
        )
        .bind(
          row.user_id,
          row.access_token_reference_id ?? row.refresh_token_reference_id,
          row.refresh_token_reference_id,
        ),
    ]);
    return ended[0]?.meta.changes === 1;
  };

  /**
   * Commits a journalled answer: both credentials, the authorization's
   * pointers to them, and the removal of the ones they replace, in one D1
   * batch. Replaying it is harmless. An authorization that ended meanwhile
   * keeps nothing of it.
   */
  const commit = async (
    entry: Extract<RenewalJournalEntry, { stage: "answered" }>,
    verifiedAt: string | null,
  ) => {
    const row = await readRow(entry.authorizationId);
    if (row?.refresh_token_reference_id === entry.refresh.id)
      return "committed";
    const nowMs = Date.now();
    const now = iso(nowMs);
    const owner = ownerOf(entry.userId);
    const failures = verifiedAt === null ? (row?.renewal_failures ?? 0) + 1 : 0;
    const next =
      verifiedAt === null
        ? nowMs + backoff(failures)
        : Date.parse(entry.expiresAt) - RENEW_BEFORE_MS;
    const results = await db.batch([
      insertSealedIntegrationCredential(db, owner, entry.access, now),
      insertSealedIntegrationCredential(db, owner, entry.refresh, now),
      db
        .prepare(
          "UPDATE github_user_authorization SET access_token_reference_id = ?, refresh_token_reference_id = ?, expires_at = ?, refresh_expires_at = ?, next_renewal_at = ?, last_renewed_at = ?, last_verified_at = COALESCE(?, last_verified_at), renewal_failures = ?, renewal_failing_since = CASE WHEN ? IS NULL THEN COALESCE(renewal_failing_since, ?) ELSE NULL END, last_renewal_error = CASE WHEN ? IS NULL THEN 'verify' ELSE NULL END, updated_at = ? WHERE id = ? AND status = 'active' AND refresh_token_reference_id = ?",
        )
        .bind(
          entry.access.id,
          entry.refresh.id,
          entry.expiresAt,
          entry.refreshExpiresAt,
          iso(Math.max(next, nowMs + MIN_RENEWAL_GAP_MS)),
          now,
          verifiedAt,
          failures,
          verifiedAt,
          now,
          verifiedAt,
          now,
          entry.authorizationId,
          entry.previousRefresh,
        ),
      // The replaced credentials go once the authorization points past them.
      db
        .prepare(
          "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (?, ?) AND EXISTS (SELECT 1 FROM github_user_authorization WHERE id = ? AND refresh_token_reference_id = ?)",
        )
        .bind(
          entry.userId,
          entry.previousAccess ?? entry.previousRefresh,
          entry.previousRefresh,
          entry.authorizationId,
          entry.refresh.id,
        ),
      // An answer for an authorization that ended meanwhile is dropped.
      db
        .prepare(
          "DELETE FROM integration_credential WHERE owner_scope = 'personal' AND owner_id = ? AND id IN (?, ?) AND NOT EXISTS (SELECT 1 FROM github_user_authorization WHERE id = ? AND refresh_token_reference_id = ?)",
        )
        .bind(
          entry.userId,
          entry.access.id,
          entry.refresh.id,
          entry.authorizationId,
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
      // GitHub answered and the object was reset before D1 committed. The
      // journalled tokens are the only live ones: commit them.
      const result = await commit(entry, null);
      log(
        entry.authorizationId,
        "recovery",
        "refreshed",
        `recovered-${result}`,
      );
    } else {
      // The object was reset after sending and before any answer. GitHub may
      // have rotated; the next renewal finds out and, if it is refused,
      // honestly asks for a reconnect.
      log(entry.authorizationId, "recovery", "retryable", "answer-lost");
    }
    await journal.clear();
  };

  const renewOnce = async (
    request: RenewalRequest,
  ): Promise<RenewalOutcome> => {
    const journal = input.journalFor(request.authorizationId);
    await recover(journal);
    const row = await readRow(request.authorizationId);
    if (
      row === null ||
      row.user_id !== request.userId ||
      row.status !== "active" ||
      row.refresh_token_reference_id === null
    )
      return { outcome: "reauthorization-required" };
    // A token that never expires (expiring user tokens off) never renews.
    if (row.expires_at === null) return { outcome: "current" };
    const now = Date.now();
    const expiresAt = Date.parse(row.expires_at) || 0;
    const nextRenewalAt =
      row.next_renewal_at === null
        ? expiresAt - RENEW_BEFORE_MS
        : Date.parse(row.next_renewal_at) || 0;
    // Due once its time comes. A request inside the last hour renews early
    // too, unless a failure's backoff is running and the token still works.
    const due =
      nextRenewalAt <= now ||
      (request.trigger === "use" &&
        expiresAt - now <= RENEW_BEFORE_MS &&
        ((row.renewal_failures ?? 0) === 0 || expiresAt - now <= 60_000));
    if (!due) return { outcome: "current" };

    await journal.write({
      stage: "sent",
      authorizationId: row.id,
      at: iso(now),
    });
    let tokens: Awaited<ReturnType<typeof provider.refresh>>;
    try {
      const refreshToken = await Effect.runPromise(
        vault.read(
          keyring,
          ownerOf(row.user_id),
          "refresh-token",
          integrationCredentialReferenceFor(
            row.refresh_token_reference_id as never,
          ),
        ),
      );
      tokens = await provider.refresh(refreshToken);
    } catch (cause) {
      await journal.clear();
      if (
        cause instanceof GitHubProviderError &&
        cause.category === "invalid-grant"
      ) {
        const ended = await endAuthorization(row, "bad_refresh_token");
        log(row.id, request.trigger, "refused", "invalid-grant", { ended });
        return { outcome: "reauthorization-required" };
      }
      const reason = categoryOf(cause);
      const retryAt =
        cause instanceof GitHubProviderError ? cause.retryAt : undefined;
      const nextRenewal = await recordFailure(row, reason, retryAt);
      log(row.id, request.trigger, "retryable", reason, {
        failures: (row.renewal_failures ?? 0) + 1,
        nextRenewalAt: nextRenewal,
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
      authorizationId: row.id,
      userId: row.user_id,
      previousAccess: row.access_token_reference_id,
      previousRefresh: row.refresh_token_reference_id,
      access,
      refresh,
      expiresAt: tokens.expiresAt.toISOString(),
      refreshExpiresAt: tokens.refreshExpiresAt?.toISOString() ?? null,
      at: iso(Date.now()),
    } satisfies RenewalJournalEntry;
    await journal.write(answered);

    // Prove the new access token with an authenticated call before relying
    // on it. The rotation is committed either way: its refresh token is the
    // only one GitHub still accepts.
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
      if (settled?.refresh_token_reference_id !== answered.refresh.id)
        throw cause;
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
        sourceControlLogger.warn("GitHub user token refresh settled.", {
          event: "github_user_token_refresh",
          authorizationId: request.authorizationId,
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
 * Serializes renewals per authorization within this isolate, for
 * deployments and tests without the coordinator binding.
 */
export const serializedRenewer = (
  renewer: () => GitHubRenewer,
): GitHubRenewer => {
  const chains = new Map<string, Promise<unknown>>();
  return {
    renew: (request) => {
      const key = request.authorizationId;
      const previous = chains.get(key) ?? Promise.resolve();
      const run = previous
        .catch(() => undefined)
        .then(() => renewer().renew(request));
      const settled = run.catch(() => undefined);
      chains.set(key, settled);
      void settled.then(() => {
        if (chains.get(key) === settled) chains.delete(key);
      });
      return run;
    },
  };
};
