import {
  ModeConfig,
  ModeId,
  StoredModelConnection,
  ThreadModelSelection,
} from "@dx/domain";
import { Schema } from "effect";

/**
 * Promise-style model-connection store for routes, the resolver, and the
 * credential coordinator DO. Shares the `model_connection` schema with
 * `repository-d1.ts` (the Effect service used by layered code).
 */

const ConnectionRow = Schema.Struct({
  id: Schema.String,
  scope: Schema.String,
  target_id: Schema.String,
  name: Schema.String,
  kind: Schema.String,
  provider_id: Schema.String,
  base_url: Schema.NullOr(Schema.String),
  format: Schema.NullOr(Schema.String),
  fields: Schema.String,
  enabled: Schema.Number,
  priority: Schema.Number,
  health_state: Schema.String,
  health_code: Schema.String,
  health_checked_at: Schema.NullOr(Schema.String),
  model_credential_id: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});

const ConnectionModelRow = Schema.Struct({
  connection_id: Schema.String,
  canonical: Schema.String,
  upstream: Schema.NullOr(Schema.String),
  position: Schema.Number,
});

const ConnectionHeaderRow = Schema.Struct({
  connection_id: Schema.String,
  name: Schema.String,
  value: Schema.String,
  position: Schema.Number,
});

const columns = `
  id, scope, target_id, name, kind, provider_id, base_url, format, fields,
  enabled, priority, health_state, health_code, health_checked_at,
  model_credential_id, created_at, updated_at
`;

const decode = async (
  db: D1Database,
  rows: ReadonlyArray<typeof ConnectionRow.Type>,
): Promise<StoredModelConnection[]> => {
  if (rows.length === 0) return [];
  const placeholders = rows.map(() => "?").join(", ");
  const [models, headers] = await Promise.all([
    db
      .prepare(
        `SELECT connection_id, canonical, upstream, position
         FROM model_connection_model
         WHERE connection_id IN (${placeholders})
         ORDER BY position ASC, canonical`,
      )
      .bind(...rows.map(({ id }) => id))
      .all(),
    db
      .prepare(
        `SELECT connection_id, name, value, position
         FROM model_connection_header
         WHERE connection_id IN (${placeholders})
         ORDER BY position ASC, name`,
      )
      .bind(...rows.map(({ id }) => id))
      .all(),
  ]);
  const modelRows = Schema.decodeUnknownSync(Schema.Array(ConnectionModelRow))(
    models.results,
  );
  const headerRows = Schema.decodeUnknownSync(
    Schema.Array(ConnectionHeaderRow),
  )(headers.results);
  return rows.map((row) =>
    Schema.decodeUnknownSync(StoredModelConnection)({
      id: row.id,
      target: { scope: row.scope, id: row.target_id },
      name: row.name,
      kind: row.kind,
      providerId: row.provider_id,
      ...(row.base_url === null ? {} : { baseUrl: row.base_url }),
      ...(row.format === null ? {} : { format: row.format }),
      fields: JSON.parse(row.fields),
      headers: headerRows
        .filter(({ connection_id }) => connection_id === row.id)
        .map(({ name, value }) => ({ name, value })),
      models: modelRows
        .filter(({ connection_id }) => connection_id === row.id)
        .map(({ canonical, upstream }) => ({
          canonical,
          ...(upstream === null ? {} : { upstream }),
        })),
      enabled: row.enabled === 1,
      priority: row.priority,
      health: {
        state: row.health_state,
        code: row.health_code,
        ...(row.health_checked_at === null
          ? {}
          : { checkedAt: row.health_checked_at }),
      },
      ...(row.model_credential_id === null
        ? {}
        : { credentialId: row.model_credential_id }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }),
  );
};

export const loadConnectionsForTarget = async (
  db: D1Database,
  target: { scope: string; id: string },
): Promise<StoredModelConnection[]> => {
  const result = await db
    .prepare(
      `SELECT ${columns}
       FROM model_connection
       WHERE scope = ? AND target_id = ?
       ORDER BY priority ASC, created_at ASC, id`,
    )
    .bind(target.scope, target.id)
    .all();
  return decode(
    db,
    Schema.decodeUnknownSync(Schema.Array(ConnectionRow))(result.results),
  );
};

export const loadConnectionForTarget = async (
  db: D1Database,
  target: { scope: string; id: string },
  id: string,
): Promise<StoredModelConnection | undefined> =>
  (await loadConnectionsForTarget(db, target)).find(
    (connection) => connection.id === id,
  );

/**
 * Personal connections, then the user's one workspace, each in priority
 * order. Reject corrupt multiple memberships rather than mix billing scopes.
 */
export const loadRoutableConnections = async (
  db: D1Database,
  ownerUserId: string,
): Promise<StoredModelConnection[]> => {
  const [membership, result] = await db.batch([
    db
      .prepare("SELECT COUNT(*) AS count FROM member WHERE userId = ?")
      .bind(ownerUserId),
    db
      .prepare(
        `SELECT ${columns}
       FROM model_connection
       WHERE (scope = 'personal' AND target_id = ? AND (
                NOT EXISTS (SELECT 1 FROM member WHERE userId = ?)
                OR COALESCE((
                  SELECT workspace_policy.allow_personal_provider_overrides
                  FROM member
                  LEFT JOIN workspace_policy
                    ON workspace_policy.workspace_id = member.organizationId
                  WHERE member.userId = ?
                  LIMIT 1
                ), 1) = 1
              ))
          OR (scope = 'workspace' AND target_id IN (
                SELECT organizationId FROM member WHERE userId = ?))
       ORDER BY CASE WHEN scope = 'personal' THEN 0 ELSE 1 END,
                priority ASC, created_at ASC, id`,
      )
      .bind(ownerUserId, ownerUserId, ownerUserId, ownerUserId),
  ]);
  const count = Schema.decodeUnknownSync(
    Schema.Struct({ count: Schema.Number }),
  )(membership?.results[0]);
  if (count.count > 1) throw new Error("WORKSPACE_MEMBERSHIP_INVALID");
  return decode(
    db,
    Schema.decodeUnknownSync(Schema.Array(ConnectionRow))(
      result?.results ?? [],
    ),
  );
};

/** Copilot entitlement model ids for a subscription connection. */
export const loadSubscriptionModelIds = async (
  db: D1Database,
  ownerUserId: string,
  connectionId: string,
): Promise<ReadonlyArray<string> | undefined> => {
  const row = await db
    .prepare(
      `SELECT status, entitlement_model_ids_json
       FROM personal_model_subscription_connection
       WHERE id = ? AND owner_user_id = ?`,
    )
    .bind(connectionId, ownerUserId)
    .first<{ status: string; entitlement_model_ids_json: string }>();
  if (row === null || row.status !== "connected") return undefined;
  return Schema.decodeUnknownSync(Schema.Array(Schema.String))(
    JSON.parse(row.entitlement_model_ids_json),
  );
};

export type ModeOverrideSource = "override" | "workspace";

/**
 * Mode Dial overrides that apply to a user, keyed by mode (profile
 * `default`): the user's own override wins over their active workspace's,
 * and a mode with neither resolves from the shipped profile.
 */
export const loadModeOverrideSources = async (
  db: D1Database,
  userId: string,
): Promise<
  ReadonlyMap<
    ModeId,
    { readonly config: ModeConfig; readonly source: ModeOverrideSource }
  >
> => {
  const result = await db
    .prepare(
      `SELECT mode, config, 'override' AS source FROM mode_profile_override
        WHERE user_id = ?1 AND profile_id = 'default'
       UNION ALL
       SELECT workspace_override.mode, workspace_override.config,
              'workspace' AS source
         FROM workspace_mode_profile_override AS workspace_override
         JOIN member ON member.organizationId = workspace_override.workspace_id
         JOIN organization ON organization.id = workspace_override.workspace_id
        WHERE member.userId = ?1 AND workspace_override.profile_id = 'default'
          AND organization.lifecycleState = 'active'`,
    )
    .bind(userId)
    .all();
  const rows = Schema.decodeUnknownSync(
    Schema.Array(
      Schema.Struct({
        mode: ModeId,
        config: Schema.String,
        source: Schema.Literals(["override", "workspace"]),
      }),
    ),
  )(result.results);
  const overrides = new Map<
    ModeId,
    { readonly config: ModeConfig; readonly source: ModeOverrideSource }
  >();
  for (const row of rows) {
    if (overrides.get(row.mode)?.source === "override") continue;
    overrides.set(row.mode, {
      config: Schema.decodeUnknownSync(ModeConfig)(JSON.parse(row.config)),
      source: row.source,
    });
  }
  return overrides;
};

/** Effective Mode Dial overrides for a user (personal, then workspace). */
export const loadModeProfileOverrides = async (
  db: D1Database,
  ownerUserId: string,
): Promise<ReadonlyMap<ModeId, ModeConfig>> =>
  new Map(
    [...(await loadModeOverrideSources(db, ownerUserId))].map(
      ([mode, { config }]) => [mode, config],
    ),
  );

/** A workspace's own Mode Dial overrides, keyed by mode. */
export const loadWorkspaceModeOverrides = async (
  db: D1Database,
  workspaceId: string,
): Promise<ReadonlyMap<ModeId, ModeConfig>> => {
  const result = await db
    .prepare(
      `SELECT mode, config FROM workspace_mode_profile_override
        WHERE workspace_id = ? AND profile_id = 'default'`,
    )
    .bind(workspaceId)
    .all();
  const rows = Schema.decodeUnknownSync(
    Schema.Array(Schema.Struct({ mode: ModeId, config: Schema.String })),
  )(result.results);
  return new Map(
    rows.map(({ mode, config }) => [
      mode,
      Schema.decodeUnknownSync(ModeConfig)(JSON.parse(config)),
    ]),
  );
};

export interface ThreadRoute {
  readonly threadId: string;
  readonly ownerUserId: string;
  readonly selection: ThreadModelSelection;
}

export const loadThreadRoute = async (
  db: D1Database,
  threadId: string,
): Promise<ThreadRoute | undefined> => {
  const row = await db
    .prepare(
      `SELECT id, owner_user_id, model_selection
       FROM threads WHERE id = ? AND lifecycle_state = 'active'`,
    )
    .bind(threadId)
    .first<{
      id: string;
      owner_user_id: string;
      model_selection: string;
    }>();
  if (row === null) return undefined;
  return {
    threadId: row.id,
    ownerUserId: row.owner_user_id,
    selection: Schema.decodeUnknownSync(ThreadModelSelection)(
      JSON.parse(row.model_selection),
    ),
  };
};

export const updateConnectionHealth = async (
  db: D1Database,
  connection: StoredModelConnection,
  health: { state: string; code: string },
): Promise<void> => {
  const checkedAt = new Date().toISOString();
  await db
    .prepare(
      `UPDATE model_connection
       SET health_state = ?, health_code = ?, health_checked_at = ?,
           updated_at = ?
       WHERE id = ? AND scope = ? AND target_id = ?`,
    )
    .bind(
      health.state,
      health.code,
      checkedAt,
      checkedAt,
      connection.id,
      connection.target.scope,
      connection.target.id,
    )
    .run()
    .catch(() => undefined);
};
