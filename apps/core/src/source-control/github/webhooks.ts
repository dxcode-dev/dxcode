import { getLogger } from "@logtape/logtape";
import { Effect, Redacted, Schema } from "effect";
import type { GitHubAppConfiguration } from "./configuration.js";
import { reconcileGitHubInstallationWithApp } from "./control-plane.js";
import { GitHubProviderError } from "./provider-http.js";

export const GITHUB_WEBHOOK_MAX_BYTES = 1024 * 1024;
const DELIVERY_TTL_MS = 30 * 24 * 60 * 60 * 1_000;
const PROCESSING_RECOVERY_MS = 5 * 60 * 1_000;
const logger = getLogger(["dx", "source-control", "github", "webhook"]);

export class GitHubWebhookInvalid extends Schema.TaggedError<GitHubWebhookInvalid>()(
  "GitHubWebhookInvalid",
  {},
) {}

export class GitHubWebhookUnavailable extends Schema.TaggedError<GitHubWebhookUnavailable>()(
  "GitHubWebhookUnavailable",
  {},
) {}

export const GITHUB_WEBHOOK_EVENTS = [
  "ping",
  "github_app_authorization",
  "installation",
  "installation_repositories",
  "installation_target",
  "repository",
] as const;
export type GitHubWebhookEvent = (typeof GITHUB_WEBHOOK_EVENTS)[number];

const hex = (value: Uint8Array) =>
  [...value].map((byte) => byte.toString(16).padStart(2, "0")).join("");

export const sha256Hex = async (body: Uint8Array) =>
  hex(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", Uint8Array.from(body)),
    ),
  );

export const verifyGitHubWebhookSignature = async (
  body: Uint8Array,
  signature: string,
  secret: string,
) => {
  if (!/^sha256=[a-f0-9]{64}$/.test(signature)) return false;
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["verify"],
  );
  const expected = Uint8Array.from(
    signature.slice(7).match(/../g) ?? [],
    (value) => Number.parseInt(value, 16),
  );
  return crypto.subtle.verify("HMAC", key, expected, Uint8Array.from(body));
};

const record = (value: unknown): Record<string, unknown> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    throw new GitHubWebhookInvalid();
  return value as Record<string, unknown>;
};

const text = (value: unknown, maximum = 512) => {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum)
    throw new GitHubWebhookInvalid();
  return value;
};

const id = (value: unknown) => {
  const normalized = typeof value === "number" ? String(value) : value;
  if (typeof normalized !== "string" || !/^[1-9][0-9]{0,30}$/.test(normalized))
    throw new GitHubWebhookInvalid();
  return normalized;
};

const githubUrl = (value: unknown) => {
  const raw = text(value, 4_096);
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "https:" ||
      url.origin !== "https://github.com" ||
      url.username ||
      url.password
    )
      throw new GitHubWebhookInvalid();
    return url.toString();
  } catch (cause) {
    if (cause instanceof GitHubWebhookInvalid) throw cause;
    throw new GitHubWebhookInvalid();
  }
};

const installationId = (payload: Record<string, unknown>) =>
  id(record(payload.installation).id);

const incrementEpoch = (
  db: D1Database,
  kind: "user-authorization" | "installation" | "owner-grant",
  subjectId: string,
  now: string,
) =>
  db
    .prepare(`
      INSERT INTO github_authorization_epoch (subject_kind, subject_id, epoch, updated_at)
      VALUES (?, ?, 2, ?)
      ON CONFLICT(subject_kind, subject_id) DO UPDATE SET
        epoch = epoch + 1, updated_at = excluded.updated_at
    `)
    .bind(kind, subjectId, now);

const ownerEpochs = async (
  db: D1Database,
  installation: string,
  now: string,
) => {
  const grants = await db
    .prepare("SELECT id FROM github_owner_grant WHERE installation_id = ?")
    .bind(installation)
    .all<{ id: string }>();
  return grants.results.map((grant) =>
    incrementEpoch(db, "owner-grant", grant.id, now),
  );
};

const decodeRepository = (value: unknown) => {
  const repository = record(value);
  const visibility =
    repository.visibility ??
    (repository.private === true ? "private" : "public");
  if (
    visibility !== "public" &&
    visibility !== "private" &&
    visibility !== "internal"
  )
    throw new GitHubWebhookInvalid();
  return {
    id: id(repository.id),
    fullName: text(repository.full_name),
    webUrl: githubUrl(repository.html_url),
    visibility,
  };
};

const eventActions: Record<GitHubWebhookEvent, ReadonlySet<string>> = {
  ping: new Set(["ping"]),
  github_app_authorization: new Set(["revoked"]),
  installation: new Set([
    "created",
    "suspend",
    "deleted",
    "unsuspend",
    "new_permissions_accepted",
  ]),
  installation_repositories: new Set(["added", "removed"]),
  installation_target: new Set(["renamed"]),
  repository: new Set([
    "renamed",
    "transferred",
    "deleted",
    "privatized",
    "publicized",
    "archived",
    "unarchived",
    "edited",
  ]),
};

const processEvent = async (
  db: D1Database,
  config: GitHubAppConfiguration,
  event: GitHubWebhookEvent,
  action: string,
  payload: Record<string, unknown>,
  now: string,
  reconcileInstallation: (installationId: string) => Promise<unknown>,
) => {
  if (event === "ping") return undefined;
  if (event === "github_app_authorization") {
    const senderId = id(record(payload.sender).id);
    const authorizations = await db
      .prepare(
        `SELECT id, user_id, access_token_reference_id, refresh_token_reference_id
           FROM github_user_authorization
          WHERE provider_account_id = ? AND status = 'active'`,
      )
      .bind(senderId)
      .all<{
        id: string;
        user_id: string;
        access_token_reference_id: string | null;
        refresh_token_reference_id: string | null;
      }>();
    const credentialReferences = new Set(
      authorizations.results.flatMap((authorization) =>
        [
          authorization.access_token_reference_id,
          authorization.refresh_token_reference_id,
        ].filter((reference): reference is string => reference !== null),
      ),
    );
    const personalGrants = await Promise.all(
      authorizations.results.map((authorization) =>
        db
          .prepare(`
            SELECT id FROM github_owner_grant
             WHERE owner_scope = 'personal' AND owner_id = ? AND status = 'active'
          `)
          .bind(authorization.user_id)
          .all<{ id: string }>(),
      ),
    );
    const personalGrantIds = personalGrants.flatMap((result) =>
      result.results.map((grant) => grant.id),
    );
    await db.batch([
      db
        .prepare(`
          UPDATE github_user_authorization
             SET status = 'revoked', access_token_reference_id = NULL,
                 refresh_token_reference_id = NULL, updated_at = ?
           WHERE provider_account_id = ? AND status != 'revoked'
        `)
        .bind(now, senderId),
      ...authorizations.results.map((authorization) =>
        incrementEpoch(db, "user-authorization", authorization.id, now),
      ),
      ...authorizations.results.map((authorization) =>
        db
          .prepare(`
            UPDATE github_owner_grant
               SET status = 'reauthorization-required', updated_at = ?
             WHERE owner_scope = 'personal' AND owner_id = ? AND status = 'active'
          `)
          .bind(now, authorization.user_id),
      ),
      ...personalGrantIds.map((grantId) =>
        incrementEpoch(db, "owner-grant", grantId, now),
      ),
      ...[...credentialReferences].map((reference) =>
        db
          .prepare("DELETE FROM integration_credential WHERE id = ?")
          .bind(reference),
      ),
    ]);
    return undefined;
  }

  const installation = installationId(payload);
  if (event === "installation") {
    if (action === "created") {
      const value = record(payload.installation);
      const account = record(value.account);
      const accountType = account.type;
      const repositorySelection = value.repository_selection;
      if (
        (accountType !== "User" && accountType !== "Organization") ||
        (repositorySelection !== "all" && repositorySelection !== "selected")
      )
        throw new GitHubWebhookInvalid();
      await db
        .prepare(`
          INSERT INTO github_installation (
            installation_id, app_id, provider_account_id, provider_account_type,
            provider_account_login, repository_selection, status,
            permissions_version, created_at, updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, 'permissions-pending', 1, ?, ?)
          ON CONFLICT(installation_id) DO UPDATE SET
            provider_account_login = excluded.provider_account_login,
            repository_selection = excluded.repository_selection,
            updated_at = excluded.updated_at
        `)
        .bind(
          installation,
          config.appId,
          id(account.id),
          accountType.toLowerCase(),
          text(account.login, 256),
          repositorySelection,
          now,
          now,
        )
        .run();
      return installation;
    }
    const status =
      action === "suspend"
        ? "suspended"
        : action === "deleted"
          ? "removed"
          : "permissions-pending";
    const ownerStatements = await ownerEpochs(db, installation, now);
    await db.batch([
      db
        .prepare(`
          UPDATE github_installation
             SET status = ?, suspended_at = ?, removed_at = ?,
                 permissions_version = permissions_version + ?, updated_at = ?
           WHERE installation_id = ?
        `)
        .bind(
          status,
          action === "suspend" ? now : null,
          action === "deleted" ? now : null,
          action === "new_permissions_accepted" ? 1 : 0,
          now,
          installation,
        ),
      incrementEpoch(db, "installation", installation, now),
      ...ownerStatements,
      ...(action === "deleted"
        ? [
            db
              .prepare(`
                UPDATE github_owner_grant
                   SET status = 'disconnected', updated_at = ?
                 WHERE installation_id = ? AND status != 'disconnected'
              `)
              .bind(now, installation),
            db
              .prepare(
                "DELETE FROM github_owner_repository_selection WHERE installation_id = ?",
              )
              .bind(installation),
            db
              .prepare(`
                UPDATE github_installation_repository
                   SET entitled = 0, last_reconciled_at = ?
                 WHERE installation_id = ?
              `)
              .bind(now, installation),
          ]
        : []),
    ]);
    if (action === "unsuspend" || action === "new_permissions_accepted")
      await reconcileInstallation(installation);
    return installation;
  }

  if (event === "installation_repositories") {
    const installationPayload = record(payload.installation);
    const repositorySelection = installationPayload.repository_selection;
    if (repositorySelection !== "all" && repositorySelection !== "selected")
      throw new GitHubWebhookInvalid();
    const previous = await db
      .prepare(
        "SELECT repository_selection, status FROM github_installation WHERE installation_id = ?",
      )
      .bind(installation)
      .first<{
        repository_selection: "all" | "selected";
        status: string;
      }>();
    if (previous === null) throw new GitHubWebhookInvalid();
    if (action === "removed" && previous.status === "removed")
      return installation;
    const allToSelected =
      previous.repository_selection === "all" &&
      repositorySelection === "selected";
    const key =
      action === "added" ? "repositories_added" : "repositories_removed";
    const values = payload[key];
    if (!Array.isArray(values) || values.length > 1_000)
      throw new GitHubWebhookInvalid();
    const repositories = values.map(decodeRepository);
    if (action === "added") {
      await db.batch([
        db
          .prepare(
            "UPDATE github_installation SET repository_selection = ?, updated_at = ? WHERE installation_id = ?",
          )
          .bind(repositorySelection, now, installation),
        ...repositories.map((repository) =>
          db
            .prepare(`
              INSERT INTO github_installation_repository (
                installation_id, provider_repository_id, full_name, web_url,
                visibility, entitled, last_reconciled_at
              ) VALUES (?, ?, ?, ?, ?, 0, ?)
              ON CONFLICT(installation_id, provider_repository_id) DO UPDATE SET
                full_name = excluded.full_name, web_url = excluded.web_url,
                visibility = excluded.visibility,
                last_reconciled_at = excluded.last_reconciled_at
            `)
            .bind(
              installation,
              repository.id,
              repository.fullName,
              repository.webUrl,
              repository.visibility,
              now,
            ),
        ),
      ]);
      await reconcileInstallation(installation);
      return installation;
    }
    const ownerStatements = await ownerEpochs(db, installation, now);
    const repositoryIds = repositories.map((repository) => repository.id);
    const updates = repositoryIds.flatMap((repositoryId) => [
      db
        .prepare(`
          DELETE FROM github_owner_repository_selection
           WHERE installation_id = ? AND provider_repository_id = ?
        `)
        .bind(installation, repositoryId),
      db
        .prepare(`
          UPDATE github_installation_repository
             SET entitled = 0, last_reconciled_at = ?
           WHERE installation_id = ? AND provider_repository_id = ?
        `)
        .bind(now, installation, repositoryId),
    ]);
    await db.batch([
      ...updates,
      ...(allToSelected
        ? [
            db
              .prepare(`
                UPDATE github_installation
                   SET repository_selection = ?, status = 'permissions-pending',
                       updated_at = ?
                 WHERE installation_id = ?
              `)
              .bind(repositorySelection, now, installation),
          ]
        : [
            db
              .prepare(
                "UPDATE github_installation SET repository_selection = ?, updated_at = ? WHERE installation_id = ?",
              )
              .bind(repositorySelection, now, installation),
          ]),
      incrementEpoch(db, "installation", installation, now),
      ...ownerStatements,
    ]);
    try {
      await reconcileInstallation(installation);
    } catch (cause) {
      if (
        !(cause instanceof GitHubProviderError) ||
        cause.category !== "not-found"
      )
        throw cause;
      const current = await db
        .prepare(
          "SELECT status FROM github_installation WHERE installation_id = ?",
        )
        .bind(installation)
        .first<{ status: string }>();
      if (current?.status !== "removed") throw cause;
    }
    return installation;
  }

  if (event === "installation_target") {
    const account = record(record(payload.installation).account);
    await db
      .prepare(
        "UPDATE github_installation SET provider_account_login = ?, updated_at = ? WHERE installation_id = ?",
      )
      .bind(text(account.login, 256), now, installation)
      .run();
    return installation;
  }

  const repository = decodeRepository(payload.repository);
  if (action !== "deleted") {
    await db
      .prepare(`
        UPDATE github_installation_repository
           SET full_name = ?, web_url = ?, visibility = ?, last_reconciled_at = ?
         WHERE installation_id = ? AND provider_repository_id = ?
      `)
      .bind(
        repository.fullName,
        repository.webUrl,
        repository.visibility,
        now,
        installation,
        repository.id,
      )
      .run();
    return installation;
  }
  const ownerStatements = await ownerEpochs(db, installation, now);
  await db.batch([
    db
      .prepare(
        "DELETE FROM github_owner_repository_selection WHERE installation_id = ? AND provider_repository_id = ?",
      )
      .bind(installation, repository.id),
    db
      .prepare(`
        UPDATE github_installation_repository SET entitled = 0, last_reconciled_at = ?
         WHERE installation_id = ? AND provider_repository_id = ?
      `)
      .bind(now, installation, repository.id),
    incrementEpoch(db, "installation", installation, now),
    ...ownerStatements,
  ]);
  return installation;
};

const fromPromise = <A>(
  operation: () => Promise<A>,
): Effect.Effect<A, unknown> =>
  Effect.tryPromise({ try: operation, catch: (cause) => cause });

export const processGitHubWebhook = (input: {
  readonly db: D1Database;
  readonly config: GitHubAppConfiguration;
  readonly deliveryId: string;
  readonly event: string;
  readonly signature: string;
  readonly body: Uint8Array;
  readonly fetcher?: typeof fetch;
  readonly reconcileInstallation?: (installationId: string) => Promise<unknown>;
}) =>
  Effect.gen(function* () {
    if (
      input.body.byteLength > GITHUB_WEBHOOK_MAX_BYTES ||
      !/^[A-Za-z0-9-]{1,128}$/.test(input.deliveryId) ||
      !(GITHUB_WEBHOOK_EVENTS as ReadonlyArray<string>).includes(input.event)
    )
      return yield* new GitHubWebhookInvalid();
    const verified = yield* fromPromise(() =>
      verifyGitHubWebhookSignature(
        input.body,
        input.signature,
        Redacted.value(input.config.webhookSecret),
      ),
    );
    if (!verified) return yield* new GitHubWebhookInvalid();
    const event = input.event as GitHubWebhookEvent;
    const { payload, action } = yield* Effect.try({
      try: () => {
        const payload = record(
          JSON.parse(
            new TextDecoder("utf-8", { fatal: true }).decode(input.body),
          ),
        );
        const action = event === "ping" ? "ping" : text(payload.action, 64);
        if (!eventActions[event].has(action)) throw new GitHubWebhookInvalid();
        return { payload, action };
      },
      catch: (cause) =>
        cause instanceof GitHubWebhookInvalid
          ? cause
          : new GitHubWebhookInvalid(),
    });
    const digest = yield* fromPromise(() => sha256Hex(input.body));
    const now = new Date();
    const expiresAt = new Date(now.getTime() + DELIVERY_TTL_MS).toISOString();
    const inserted = yield* fromPromise(() =>
      input.db
        .prepare(`
        INSERT OR IGNORE INTO github_webhook_delivery (
          delivery_id, event, action, payload_sha256, state, attempts,
          received_at, updated_at, expires_at
        ) VALUES (?, ?, ?, ?, 'processing', 1, ?, ?, ?)
      `)
        .bind(
          input.deliveryId,
          event,
          action,
          digest,
          now.toISOString(),
          now.toISOString(),
          expiresAt,
        )
        .run(),
    );
    let attempt = 1;
    if (inserted.meta.changes !== 1) {
      const delivery = yield* fromPromise(() =>
        input.db
          .prepare(
            "SELECT payload_sha256, state, attempts, updated_at FROM github_webhook_delivery WHERE delivery_id = ?",
          )
          .bind(input.deliveryId)
          .first<{
            payload_sha256: string;
            state: string;
            attempts: number;
            updated_at: string;
          }>(),
      );
      if (delivery === null || delivery.payload_sha256 !== digest)
        return yield* new GitHubWebhookInvalid();
      if (delivery.state === "processed") return { duplicate: true };
      const recoveryBefore = new Date(
        now.getTime() - PROCESSING_RECOVERY_MS,
      ).toISOString();
      if (
        delivery.state === "processing" &&
        delivery.updated_at > recoveryBefore
      )
        return yield* new GitHubWebhookUnavailable();
      attempt = delivery.attempts + 1;
      const recovered = yield* fromPromise(() =>
        input.db
          .prepare(`
          UPDATE github_webhook_delivery
             SET state = 'processing', attempts = ?, updated_at = ?
           WHERE delivery_id = ? AND attempts = ? AND attempts < 16
             AND (state = 'failed' OR (state = 'processing' AND updated_at <= ?))
        `)
          .bind(
            attempt,
            now.toISOString(),
            input.deliveryId,
            delivery.attempts,
            recoveryBefore,
          )
          .run(),
      );
      if (recovered.meta.changes !== 1)
        return yield* new GitHubWebhookUnavailable();
    }

    return yield* Effect.gen(function* () {
      const reconcileInstallation =
        input.reconcileInstallation ??
        ((installationId: string) =>
          reconcileGitHubInstallationWithApp({
            db: input.db,
            config: input.config,
            installationId,
            fetcher: input.fetcher,
          }));
      const resolvedInstallation = yield* fromPromise(() =>
        processEvent(
          input.db,
          input.config,
          event,
          action,
          payload,
          now.toISOString(),
          reconcileInstallation,
        ),
      );
      const settled = yield* fromPromise(() =>
        input.db
          .prepare(`
          UPDATE github_webhook_delivery
             SET state = 'processed', installation_id = ?, updated_at = ?, processed_at = ?
           WHERE delivery_id = ? AND state = 'processing' AND attempts = ?
        `)
          .bind(
            resolvedInstallation ?? null,
            now.toISOString(),
            now.toISOString(),
            input.deliveryId,
            attempt,
          )
          .run(),
      );
      if (settled.meta.changes !== 1)
        return yield* new GitHubWebhookUnavailable();
      logger.info("GitHub webhook processed.", {
        event: "github_webhook_processed",
        deliveryId: input.deliveryId,
        githubEvent: event,
        githubAction: action,
        installationId: resolvedInstallation,
      });
      return { duplicate: false };
    }).pipe(
      Effect.catch((cause) =>
        fromPromise(() =>
          input.db
            .prepare(
              "UPDATE github_webhook_delivery SET state = 'failed', updated_at = ? WHERE delivery_id = ? AND state = 'processing' AND attempts = ?",
            )
            .bind(now.toISOString(), input.deliveryId, attempt)
            .run(),
        ).pipe(Effect.flatMap(() => Effect.fail(cause))),
      ),
    );
  });
