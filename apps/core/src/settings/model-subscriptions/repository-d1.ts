import { Schema } from "effect";
import type { ConfigValueEnvelope } from "../config-encryption.js";

export interface SubscriptionRow {
  id: string;
  ownerUserId: string;
  provider: "github-copilot";
  providerAccountId: string;
  providerAccountLogin: string;
  status: "connected" | "needs-reauthorization";
  credentialEnvelope: ConfigValueEnvelope | null;
  credentialRevision: number;
  modelIds: ReadonlyArray<string>;
  catalogRevision: string;
  observedAt: string;
  refreshAfter: string;
  createdAt: string;
  updatedAt: string;
  connectedAt: string;
}

export interface AuthorizationRow {
  id: string;
  ownerUserId: string;
  browserSessionId: string;
  provider: "github-copilot";
  envelope: ConfigValueEnvelope;
  credentialRevision: number;
  verificationUrl: string;
  userCode: string;
  expiresAt: string;
  intervalSeconds: number;
  nextPollAt: string;
  createdAt: string;
  updatedAt: string;
}

const ConfigValueEnvelopeSchema = Schema.Struct({
  version: Schema.Literal(1),
  keyVersion: Schema.Int,
  valueNonce: Schema.String,
  ciphertext: Schema.String,
  wrappedKeyNonce: Schema.String,
  wrappedKey: Schema.String,
});
const ConnectionDatabaseRow = Schema.Struct({
  id: Schema.String,
  owner_user_id: Schema.String,
  provider: Schema.Literal("github-copilot"),
  provider_account_id: Schema.String,
  provider_account_login: Schema.String,
  status: Schema.Literals(["connected", "needs-reauthorization"]),
  credential_envelope_json: Schema.Union([Schema.Null, Schema.String]),
  credential_revision: Schema.Int,
  entitlement_model_ids_json: Schema.String,
  entitlement_catalog_revision: Schema.String,
  entitlement_observed_at: Schema.String,
  entitlement_refresh_after: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
  connected_at: Schema.String,
});
const AuthorizationDatabaseRow = Schema.Struct({
  id: Schema.String,
  owner_user_id: Schema.String,
  browser_session_id: Schema.String,
  provider: Schema.Literal("github-copilot"),
  authorization_envelope_json: Schema.String,
  credential_revision: Schema.Int,
  verification_url: Schema.String,
  user_code: Schema.String,
  expires_at: Schema.String,
  interval_seconds: Schema.Int,
  next_poll_at: Schema.String,
  created_at: Schema.String,
  updated_at: Schema.String,
});

const connection = (input: unknown): SubscriptionRow => {
  const r = Schema.decodeUnknownSync(ConnectionDatabaseRow)(input);
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    provider: "github-copilot",
    providerAccountId: r.provider_account_id,
    providerAccountLogin: r.provider_account_login,
    status: r.status,
    credentialEnvelope:
      r.credential_envelope_json === null
        ? null
        : Schema.decodeUnknownSync(ConfigValueEnvelopeSchema)(
            JSON.parse(r.credential_envelope_json),
          ),
    credentialRevision: r.credential_revision,
    modelIds: Schema.decodeUnknownSync(Schema.Array(Schema.String))(
      JSON.parse(r.entitlement_model_ids_json),
    ),
    catalogRevision: r.entitlement_catalog_revision,
    observedAt: r.entitlement_observed_at,
    refreshAfter: r.entitlement_refresh_after,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    connectedAt: r.connected_at,
  };
};
const authorization = (input: unknown): AuthorizationRow => {
  const r = Schema.decodeUnknownSync(AuthorizationDatabaseRow)(input);
  return {
    id: r.id,
    ownerUserId: r.owner_user_id,
    browserSessionId: r.browser_session_id,
    provider: "github-copilot",
    envelope: Schema.decodeUnknownSync(ConfigValueEnvelopeSchema)(
      JSON.parse(r.authorization_envelope_json),
    ),
    credentialRevision: r.credential_revision,
    verificationUrl: r.verification_url,
    userCode: r.user_code,
    expiresAt: r.expires_at,
    intervalSeconds: r.interval_seconds,
    nextPollAt: r.next_poll_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
};

export class PersonalModelSubscriptionRepositoryD1 {
  constructor(private readonly db: D1Database) {}
  async list(owner: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM personal_model_subscription_connection WHERE owner_user_id = ? ORDER BY provider",
      )
      .bind(owner)
      .all();
    return r.results.map(connection);
  }
  async find(owner: string, id: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM personal_model_subscription_connection WHERE owner_user_id = ? AND id = ?",
      )
      .bind(owner, id)
      .first();
    return r === null ? undefined : connection(r);
  }
  async findAuthorization(owner: string, session: string, id: string) {
    const r = await this.db
      .prepare(
        "SELECT * FROM personal_model_subscription_authorization WHERE owner_user_id = ? AND browser_session_id = ? AND id = ?",
      )
      .bind(owner, session, id)
      .first();
    return r === null ? undefined : authorization(r);
  }
  async replaceAuthorization(row: AuthorizationRow) {
    await this.db.batch([
      this.db
        .prepare(
          "DELETE FROM personal_model_subscription_authorization WHERE owner_user_id = ? AND provider = ?",
        )
        .bind(row.ownerUserId, row.provider),
      this.db
        .prepare(
          `INSERT INTO personal_model_subscription_authorization (id,owner_user_id,browser_session_id,provider,state,verification_url,user_code,authorization_envelope_json,credential_revision,interval_seconds,next_poll_at,expires_at,created_at,updated_at) VALUES (?,?,?,?,'pending',?,?,?,?,?,?,?,?,?)`,
        )
        .bind(
          row.id,
          row.ownerUserId,
          row.browserSessionId,
          row.provider,
          row.verificationUrl,
          row.userCode,
          JSON.stringify(row.envelope),
          row.credentialRevision,
          row.intervalSeconds,
          row.nextPollAt,
          row.expiresAt,
          row.createdAt,
          row.updatedAt,
        ),
    ]);
  }
  async updatePoll(expected: AuthorizationRow, row: AuthorizationRow) {
    const r = await this.db
      .prepare(
        "UPDATE personal_model_subscription_authorization SET interval_seconds=?,next_poll_at=?,updated_at=? WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=? AND next_poll_at=?",
      )
      .bind(
        row.intervalSeconds,
        row.nextPollAt,
        row.updatedAt,
        row.id,
        row.ownerUserId,
        row.browserSessionId,
        row.credentialRevision,
        expected.nextPollAt,
      )
      .run();
    return (r.meta.changes ?? 0) === 1;
  }
  async updateAuthorizationSecret(
    expected: AuthorizationRow,
    row: AuthorizationRow,
  ) {
    const result = await this.db
      .prepare(
        "UPDATE personal_model_subscription_authorization SET authorization_envelope_json=?,credential_revision=?,next_poll_at=?,updated_at=? WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=? AND next_poll_at=?",
      )
      .bind(
        JSON.stringify(row.envelope),
        row.credentialRevision,
        row.nextPollAt,
        row.updatedAt,
        expected.id,
        expected.ownerUserId,
        expected.browserSessionId,
        expected.credentialRevision,
        expected.nextPollAt,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }
  async deleteAuthorization(owner: string, session: string, id: string) {
    await this.db
      .prepare(
        "DELETE FROM personal_model_subscription_authorization WHERE owner_user_id=? AND browser_session_id=? AND id=?",
      )
      .bind(owner, session, id)
      .run();
  }
  async complete(
    auth: AuthorizationRow,
    row: SubscriptionRow,
    configuredModels: unknown[],
  ) {
    const existing = await this.db
      .prepare(
        "SELECT id,created_at FROM personal_model_subscription_connection WHERE owner_user_id=? AND provider=?",
      )
      .bind(row.ownerUserId, row.provider)
      .first<{ id: string; created_at: string }>();
    const id = existing?.id ?? row.id;
    const created = existing?.created_at ?? row.createdAt;
    const healthy = configuredModels.length > 0;
    const projectionName = `GitHub Copilot (${id})`;
    const statements: D1PreparedStatement[] = [];
    if (existing)
      statements.push(
        this.db
          .prepare(
            "DELETE FROM model_connection WHERE id=? AND EXISTS (SELECT 1 FROM personal_model_subscription_authorization WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=?)",
          )
          .bind(
            id,
            auth.id,
            auth.ownerUserId,
            auth.browserSessionId,
            auth.credentialRevision,
          ),
      );
    statements.push(
      this.db
        .prepare(
          `INSERT INTO model_connection (id,scope,target_id,name,kind,provider_id,fields,health_state,health_code,health_checked_at,created_at,updated_at) SELECT ?,'personal',?,?,'subscription','github-copilot','{}',?,?,?,?,? WHERE EXISTS (SELECT 1 FROM personal_model_subscription_authorization WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=?)`,
        )
        .bind(
          id,
          row.ownerUserId,
          projectionName,
          healthy ? "healthy" : "unhealthy",
          healthy ? "CONNECTED" : "NO_ACTIVE_MODELS",
          row.updatedAt,
          created,
          row.updatedAt,
          auth.id,
          auth.ownerUserId,
          auth.browserSessionId,
          auth.credentialRevision,
        ),
      this.db
        .prepare(
          `INSERT INTO personal_model_subscription_connection (id,owner_user_id,provider,provider_account_id,provider_account_login,status,credential_envelope_json,credential_revision,entitlement_model_ids_json,entitlement_catalog_revision,entitlement_observed_at,entitlement_refresh_after,created_at,updated_at,connected_at) SELECT ?,?, ?,?,?,'connected',?,?,?,?,?,?,?,?,? WHERE EXISTS (SELECT 1 FROM personal_model_subscription_authorization WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=?)`,
        )
        .bind(
          id,
          row.ownerUserId,
          row.provider,
          row.providerAccountId,
          row.providerAccountLogin,
          JSON.stringify(row.credentialEnvelope),
          row.credentialRevision,
          JSON.stringify(row.modelIds),
          row.catalogRevision,
          row.observedAt,
          row.refreshAfter,
          created,
          row.updatedAt,
          row.connectedAt,
          auth.id,
          auth.ownerUserId,
          auth.browserSessionId,
          auth.credentialRevision,
        ),
      this.db
        .prepare(
          "DELETE FROM personal_model_subscription_authorization WHERE id=? AND owner_user_id=? AND browser_session_id=? AND credential_revision=?",
        )
        .bind(
          auth.id,
          auth.ownerUserId,
          auth.browserSessionId,
          auth.credentialRevision,
        ),
    );
    const results = await this.db.batch(statements);
    const subscriptionResult = results[existing === null ? 1 : 2];
    if ((subscriptionResult?.meta.changes ?? 0) !== 1) return undefined;
    return this.find(row.ownerUserId, id);
  }
  async rotateCredential(expected: SubscriptionRow, next: SubscriptionRow) {
    const result = await this.db
      .prepare(
        "UPDATE personal_model_subscription_connection SET credential_envelope_json=?,credential_revision=?,updated_at=? WHERE id=? AND owner_user_id=? AND credential_revision=? AND status='connected'",
      )
      .bind(
        JSON.stringify(next.credentialEnvelope),
        next.credentialRevision,
        next.updatedAt,
        expected.id,
        expected.ownerUserId,
        expected.credentialRevision,
      )
      .run();
    return (result.meta.changes ?? 0) === 1;
  }
  async refresh(
    expected: SubscriptionRow,
    next: SubscriptionRow,
    configuredModels: unknown[],
  ) {
    const results = await this.db.batch([
      this.db
        .prepare(
          "UPDATE model_connection SET health_state=?,health_code=?,health_checked_at=?,updated_at=? WHERE id=? AND scope='personal' AND target_id=? AND EXISTS (SELECT 1 FROM personal_model_subscription_connection WHERE id=? AND owner_user_id=? AND credential_revision=?)",
        )
        .bind(
          next.status === "connected" && configuredModels.length > 0
            ? "healthy"
            : "unhealthy",
          next.status !== "connected"
            ? "REAUTHORIZATION_REQUIRED"
            : configuredModels.length > 0
              ? "CONNECTED"
              : "NO_ACTIVE_MODELS",
          next.updatedAt,
          next.updatedAt,
          expected.id,
          expected.ownerUserId,
          expected.id,
          expected.ownerUserId,
          expected.credentialRevision,
        ),
      this.db
        .prepare(
          "UPDATE personal_model_subscription_connection SET status=?,credential_envelope_json=?,credential_revision=?,entitlement_model_ids_json=?,entitlement_catalog_revision=?,entitlement_observed_at=?,entitlement_refresh_after=?,updated_at=? WHERE id=? AND owner_user_id=? AND credential_revision=?",
        )
        .bind(
          next.status,
          next.credentialEnvelope === null
            ? null
            : JSON.stringify(next.credentialEnvelope),
          next.credentialRevision,
          JSON.stringify(next.modelIds),
          next.catalogRevision,
          next.observedAt,
          next.refreshAfter,
          next.updatedAt,
          expected.id,
          expected.ownerUserId,
          expected.credentialRevision,
        ),
    ]);
    return (results[1]?.meta.changes ?? 0) === 1;
  }
  async disconnect(owner: string, id: string) {
    const row = await this.find(owner, id);
    if (!row) return "missing" as const;
    // v2: connections are never referenced by profiles — modes name canonical
    // model ids — so disconnect never blocks (decision 14). The subscription
    // row is deleted explicitly because the 0052 wipe can leave it orphaned
    // from the recreated model_connection table.
    const results = await this.db.batch([
      this.db
        .prepare(
          `DELETE FROM personal_model_subscription_authorization
           WHERE owner_user_id = ? AND provider = ?`,
        )
        .bind(owner, row.provider),
      this.db
        .prepare(
          `DELETE FROM personal_model_subscription_connection
           WHERE id = ? AND owner_user_id = ?`,
        )
        .bind(id, owner),
      this.db
        .prepare(
          `DELETE FROM model_connection
           WHERE id = ? AND scope = 'personal' AND target_id = ?`,
        )
        .bind(id, owner),
    ]);
    if (
      (results[1]?.meta.changes ?? 0) === 1 ||
      (results[2]?.meta.changes ?? 0) === 1
    )
      return "deleted" as const;
    return (await this.find(owner, id)) === undefined
      ? ("deleted" as const)
      : ("conflict" as const);
  }
}
