import {
  decodeUsageThreadCursor,
  decodeWorkspaceUsageRankingCursor,
  encodeUsageThreadCursor,
  encodeWorkspaceUsageRankingCursor,
  estimateUsageCostMicros,
  ModelProviderId,
  type NormalizedUsageQuery,
  type NormalizedWorkspaceUsageQuery,
  PersistenceUnavailable,
  ProjectId,
  ThreadId,
  USAGE_EVENT_RETENTION_DAYS,
  UsageDate,
  UsageEventInput,
  UsageModelId,
  UsagePriceMetadata,
  UsageRepository,
  UsageResourceForbidden,
  type UsageSummary,
  UserId,
  type WorkspaceId,
  type WorkspaceUsageRanking,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";

type EncodedUsageEvent = typeof UsageEventInput.Encoded;
type EncodedUsagePrice = typeof UsagePriceMetadata.Encoded;

const SummaryRow = Schema.Struct({
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_read_tokens: Schema.Number,
  cache_write_tokens: Schema.Number,
  reasoning_tokens: Schema.NullOr(Schema.Number),
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  known_cost_events: Schema.Number,
  unknown_cost_events: Schema.Number,
  model_turns: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  tool_duration_ms: Schema.Number,
  runner_duration_ms: Schema.Number,
  success_outcomes: Schema.Number,
  error_outcomes: Schema.Number,
  cancelled_outcomes: Schema.Number,
  unknown_outcomes: Schema.Number,
});

const DailyRow = Schema.Struct({
  day: UsageDate,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  unknown_cost_events: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  runner_duration_ms: Schema.Number,
  model_turns: Schema.Number,
});

const ThreadAggregateRow = Schema.Struct({
  thread_id: ThreadId,
  project_id: ProjectId,
  project_name: Schema.String,
  created_at: Schema.DateTimeUtcFromString,
  provider_id: ModelProviderId,
  model_id: UsageModelId,
  profile_id: Schema.String,
  profile_version: Schema.Number,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  unknown_cost_events: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  runner_duration_ms: Schema.Number,
  model_turns: Schema.Number,
  error_events: Schema.Number,
});

const UserAggregateRow = Schema.Struct({
  user_id: UserId,
  user_name: Schema.String,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  unknown_cost_events: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  runner_duration_ms: Schema.Number,
  model_turns: Schema.Number,
  error_events: Schema.Number,
});

const ProjectAggregateRow = Schema.Struct({
  project_id: ProjectId,
  project_name: Schema.String,
  owner_user_id: UserId,
  owner_name: Schema.String,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  unknown_cost_events: Schema.Number,
  average_latency_ms: Schema.NullOr(Schema.Number),
  runner_duration_ms: Schema.Number,
  model_turns: Schema.Number,
  error_events: Schema.Number,
});

const RunnerAggregateRow = Schema.Struct({
  provider: Schema.Literal("e2b"),
  profile_id: Schema.NullOr(Schema.String),
  profile_version: Schema.NullOr(Schema.Number),
  template: Schema.String,
  cpu_cores: Schema.NullOr(Schema.Number),
  memory_mb: Schema.NullOr(Schema.Number),
  disk_gb: Schema.NullOr(Schema.Number),
  duration_ms: Schema.Number,
  events: Schema.Number,
  unknown_resource_events: Schema.Number,
});

const PriceSourceRow = Schema.Struct({
  source: Schema.Literals(["deployment", "catalog"]),
  source_version: Schema.String,
  currency: Schema.Literal("USD"),
  effective_from: Schema.DateTimeUtcFromString,
  effective_to: Schema.NullOr(Schema.DateTimeUtcFromString),
  fresh_until: Schema.DateTimeUtcFromString,
});

const eventColumns = `
  id, kind, owner_user_id, workspace_id, thread_id, project_id, occurred_at, expires_at, outcome,
  duration_ms, submission_id, turn_id, turn_purpose,
  connection_id, provider_id, model_id, model_route_version,
  model_profile_id, model_profile_version, model_configuration_revision,
  observed_provider_id, observed_provider_name, observed_model_id,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  reasoning_tokens, total_tokens,
  tool_call_id, tool_name, tool_origin, tool_runtime,
  runner_provider, runner_decision, runner_id, runner_template,
  runner_active_timeout_ms, runner_profile_id, runner_profile_version,
  runner_cpu_cores, runner_memory_mb, runner_disk_gb,
  estimated_cost_micros_snapshot, price_status, price_source,
  price_source_version, price_fresh_until
`;

const costSnapshot = (
  event: EncodedUsageEvent,
  price: EncodedUsagePrice | undefined,
) => {
  if (event.kind !== "model") return [null, null, null, null, null] as const;
  if (price === undefined) return [null, "unknown", null, null, null] as const;
  const occurredAt = Date.parse(event.occurredAt);
  const effectiveFrom = Date.parse(price.effectiveFrom);
  const effectiveTo =
    price.effectiveTo === null ? undefined : Date.parse(price.effectiveTo);
  const freshUntil = Date.parse(price.freshUntil);
  const current =
    effectiveFrom <= occurredAt &&
    (effectiveTo === undefined || occurredAt < effectiveTo) &&
    occurredAt <= freshUntil;
  const amount = current
    ? estimateUsageCostMicros(
        {
          input: event.inputTokens,
          output: event.outputTokens,
          cacheRead: event.cacheReadTokens,
          cacheWrite: event.cacheWriteTokens,
        },
        price,
      )
    : null;
  return [
    amount,
    amount !== null ? "fresh" : current ? "unknown" : "stale",
    price.source,
    price.sourceVersion,
    price.freshUntil,
  ] as const;
};

const eventValues = (
  event: EncodedUsageEvent,
  price: EncodedUsagePrice | undefined,
) => {
  const model = event.kind === "model" ? event : undefined;
  const submission =
    event.kind === "model" ||
    event.kind === "submission" ||
    event.kind === "tool"
      ? event.submissionId
      : null;
  const tool = event.kind === "tool" ? event : undefined;
  const runner = event.kind === "runner" ? event : undefined;
  return [
    event.id,
    event.kind,
    event.occurredAt,
    event.occurredAt,
    event.outcome,
    event.durationMs,
    submission,
    model?.turnId ?? null,
    model?.purpose ?? null,
    model?.routeAttribution?.connectionId ?? "unresolved",
    model?.routeAttribution?.providerId ?? "unresolved",
    model?.routeAttribution?.modelId ?? "unresolved",
    model?.observedProviderId ?? null,
    model?.observedProviderName ?? null,
    model?.observedModelId ?? null,
    model?.inputTokens ?? null,
    model?.outputTokens ?? null,
    model?.cacheReadTokens ?? null,
    model?.cacheWriteTokens ?? null,
    model?.reasoningTokens ?? null,
    model?.totalTokens ?? null,
    tool?.toolCallId ?? null,
    tool?.toolName ?? null,
    tool?.toolOrigin ?? null,
    tool?.runtime ?? null,
    runner?.provider ?? null,
    runner?.decision ?? null,
    runner?.runnerId ?? null,
    runner?.template ?? null,
    runner?.activeTimeoutMs ?? null,
    runner?.resources.profileId ?? null,
    runner?.resources.profileVersion ?? null,
    runner?.resources.cpuCores ?? null,
    runner?.resources.memoryMb ?? null,
    runner?.resources.diskGb ?? null,
    ...costSnapshot(event, price),
    event.threadId,
  ] as const;
};

const eventInsert = (
  db: D1Database,
  event: EncodedUsageEvent,
  price?: EncodedUsagePrice,
) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO usage_event (${eventColumns})
       SELECT
         ?, ?, thread.owner_user_id,
         (SELECT member.organizationId FROM member
          WHERE member.userId = thread.owner_user_id LIMIT 1),
         thread.id, thread.project_id, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+${USAGE_EVENT_RETENTION_DAYS} days'), ?,
         ?, ?, ?, ?,
         ?, ?, ?,
         2,
         CASE WHEN json_extract(thread.model_selection, '$.kind') = 'mode'
              THEN json_extract(thread.model_selection, '$.mode')
              ELSE 'model' END,
         1,
         0,
         ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         ?, ?, ?, ?, ?
       FROM threads AS thread
       WHERE thread.id = ?`,
    )
    .bind(...eventValues(event, price));

const encodedPriceValues = (price: EncodedUsagePrice) => [
  price.providerId,
  price.modelId,
  price.currency,
  price.source,
  price.sourceVersion,
  price.inputMicrosPerMillion,
  price.outputMicrosPerMillion,
  price.cacheReadMicrosPerMillion,
  price.cacheWriteMicrosPerMillion,
  price.effectiveFrom,
  price.effectiveTo,
  price.freshUntil,
  price.effectiveFrom,
];

const priceInsert = (db: D1Database, price: EncodedUsagePrice) =>
  db
    .prepare(
      `INSERT OR IGNORE INTO usage_price (
         provider_id, model_id, currency, source, source_version,
         input_micros_per_million, output_micros_per_million,
         cache_read_micros_per_million, cache_write_micros_per_million,
         effective_from, effective_to, fresh_until, estimated, created_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
    )
    .bind(...encodedPriceValues(price));

const unavailable = (operation: string, cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const run = <Value>(operation: string, attempt: () => Promise<Value>) =>
  Effect.tryPromise({
    try: attempt,
    catch: (cause) => unavailable(operation, cause),
  });

const queryParts = (ownerUserId: UserId, query: NormalizedUsageQuery) => {
  const clauses = [
    "event.owner_user_id = ?",
    "event.occurred_at >= ?",
    "event.occurred_at < ?",
  ];
  const values: Array<unknown> = [
    ownerUserId,
    query.fromInclusive,
    query.toExclusive,
  ];
  for (const [column, value] of [
    ["event.project_id", query.projectId],
    ["event.thread_id", query.threadId],
    [
      "COALESCE(event.observed_provider_id, event.provider_id)",
      query.providerId,
    ],
    ["COALESCE(event.observed_model_id, event.model_id)", query.modelId],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  return { where: clauses.join(" AND "), values };
};

const workspaceQueryParts = (
  workspaceId: WorkspaceId,
  query: NormalizedWorkspaceUsageQuery,
) => {
  const clauses = [
    "event.workspace_id = ?",
    "event.occurred_at >= ?",
    "event.occurred_at < ?",
  ];
  const values: Array<unknown> = [
    workspaceId,
    query.fromInclusive,
    query.toExclusive,
  ];
  for (const [column, value] of [
    ["event.owner_user_id", query.userId],
    ["event.project_id", query.projectId],
    [
      "COALESCE(event.observed_provider_id, event.provider_id)",
      query.providerId,
    ],
    ["COALESCE(event.observed_model_id, event.model_id)", query.modelId],
  ] as const) {
    if (value !== undefined) {
      clauses.push(`${column} = ?`);
      values.push(value);
    }
  }
  return { where: clauses.join(" AND "), values };
};

const costedCte = (where: string) => `
  WITH filtered AS (
    SELECT event.*
    FROM usage_event AS event
    WHERE ${where}
  ), costed AS (
    SELECT
      event.*,
      price.source AS price_source,
      price.source_version AS price_source_version,
      price.currency AS price_currency,
      price.effective_from AS price_effective_from,
      price.effective_to AS price_effective_to,
      price.fresh_until AS price_fresh_until,
      event.estimated_cost_micros_snapshot AS estimated_cost_micros
    FROM filtered AS event
    LEFT JOIN usage_price AS price ON event.price_status = 'fresh' AND price.rowid = (
      SELECT candidate.rowid
      FROM usage_price AS candidate
      WHERE candidate.provider_id = COALESCE(event.observed_provider_id, event.provider_id)
        AND candidate.model_id = COALESCE(event.observed_model_id, event.model_id)
        AND candidate.source = event.price_source
        AND candidate.source_version = event.price_source_version
        AND candidate.effective_from <= event.occurred_at
        AND (candidate.effective_to IS NULL OR event.occurred_at < candidate.effective_to)
        AND candidate.fresh_until = event.price_fresh_until
      ORDER BY
        CASE candidate.source WHEN 'deployment' THEN 0 ELSE 1 END,
        candidate.effective_from DESC,
        candidate.source_version DESC
      LIMIT 1
    )
  )
`;

const summarySql = (where: string) => `${costedCte(where)}
  SELECT
    COALESCE(SUM(CASE WHEN kind = 'model' THEN input_tokens ELSE 0 END), 0) AS input_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN output_tokens ELSE 0 END), 0) AS output_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN cache_read_tokens ELSE 0 END), 0) AS cache_read_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN cache_write_tokens ELSE 0 END), 0) AS cache_write_tokens,
    SUM(CASE WHEN kind = 'model' THEN reasoning_tokens END) AS reasoning_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' AND total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_token_events,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN estimated_cost_micros ELSE 0 END), 0) AS estimated_cost_micros,
    COALESCE(SUM(CASE WHEN kind = 'model' AND estimated_cost_micros IS NOT NULL THEN 1 ELSE 0 END), 0) AS known_cost_events,
    COALESCE(SUM(CASE WHEN kind = 'model' AND estimated_cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unknown_cost_events,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) AS model_turns,
    AVG(CASE WHEN kind = 'model' THEN duration_ms END) AS average_latency_ms,
    COALESCE(SUM(CASE WHEN kind = 'tool' THEN duration_ms ELSE 0 END), 0) AS tool_duration_ms,
    COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
    COALESCE(SUM(CASE WHEN outcome = 'success' THEN 1 ELSE 0 END), 0) AS success_outcomes,
    COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS error_outcomes,
    COALESCE(SUM(CASE WHEN outcome = 'cancelled' THEN 1 ELSE 0 END), 0) AS cancelled_outcomes,
    COALESCE(SUM(CASE WHEN outcome = 'unknown' THEN 1 ELSE 0 END), 0) AS unknown_outcomes
  FROM costed`;

const dailySql = (where: string) => `${costedCte(where)}
  SELECT
    date(occurred_at, ?) AS day,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
    COALESCE(SUM(CASE WHEN kind = 'model' AND total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_token_events,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN estimated_cost_micros ELSE 0 END), 0) AS estimated_cost_micros,
    COALESCE(SUM(CASE WHEN kind = 'model' AND estimated_cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unknown_cost_events,
    AVG(CASE WHEN kind = 'model' THEN duration_ms END) AS average_latency_ms,
    COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
    COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) AS model_turns
  FROM costed
  GROUP BY day
  ORDER BY day ASC`;

const threadSql = (where: string, hasCursor: boolean) => `${costedCte(where)},
  thread_totals AS (
    SELECT
      thread_id,
      project_id,
      MAX(COALESCE(observed_provider_id, provider_id)) AS provider_id,
      MAX(COALESCE(observed_model_id, model_id)) AS model_id,
      MAX(model_profile_id) AS profile_id,
      MAX(model_profile_version) AS profile_version,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN kind = 'model' AND total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_token_events,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN estimated_cost_micros ELSE 0 END), 0) AS estimated_cost_micros,
      COALESCE(SUM(CASE WHEN kind = 'model' AND estimated_cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unknown_cost_events,
      AVG(CASE WHEN kind = 'model' THEN duration_ms END) AS average_latency_ms,
      COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) AS model_turns,
      COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS error_events
    FROM costed
    GROUP BY thread_id, project_id
  )
  SELECT
    totals.*,
    project.name AS project_name,
    thread.created_at
  FROM thread_totals AS totals
  INNER JOIN threads AS thread ON thread.id = totals.thread_id
  INNER JOIN projects AS project ON project.id = totals.project_id
  ${
    hasCursor
      ? "WHERE totals.estimated_cost_micros < ? OR (totals.estimated_cost_micros = ? AND totals.thread_id < ?)"
      : ""
  }
  ORDER BY totals.estimated_cost_micros DESC, totals.thread_id DESC
  LIMIT ?`;

const rankingTotals = (idColumns: string) => `
    SELECT
      ${idColumns},
      COALESCE(SUM(CASE WHEN kind = 'model' THEN total_tokens ELSE 0 END), 0) AS total_tokens,
      COALESCE(SUM(CASE WHEN kind = 'model' AND total_tokens IS NULL THEN 1 ELSE 0 END), 0) AS unknown_token_events,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN estimated_cost_micros ELSE 0 END), 0) AS estimated_cost_micros,
      COALESCE(SUM(CASE WHEN kind = 'model' AND estimated_cost_micros IS NULL THEN 1 ELSE 0 END), 0) AS unknown_cost_events,
      AVG(CASE WHEN kind = 'model' THEN duration_ms END) AS average_latency_ms,
      COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
      COALESCE(SUM(CASE WHEN kind = 'model' THEN 1 ELSE 0 END), 0) AS model_turns,
      COALESCE(SUM(CASE WHEN outcome = 'error' THEN 1 ELSE 0 END), 0) AS error_events
    FROM costed`;

const userSql = (where: string, hasCursor: boolean) => `${costedCte(where)},
  user_totals AS (
    ${rankingTotals("owner_user_id AS user_id")}
    GROUP BY owner_user_id
  )
  SELECT
    totals.*,
    COALESCE(personal_account.display_name, user.name) AS user_name
  FROM user_totals AS totals
  INNER JOIN user ON user.id = totals.user_id
  LEFT JOIN personal_account ON personal_account.user_id = totals.user_id
  ${
    hasCursor
      ? "WHERE totals.estimated_cost_micros < ? OR (totals.estimated_cost_micros = ? AND totals.user_id < ?)"
      : ""
  }
  ORDER BY totals.estimated_cost_micros DESC, totals.user_id DESC
  LIMIT ?`;

const projectSql = (where: string, hasCursor: boolean) => `${costedCte(where)},
  project_totals AS (
    ${rankingTotals("project_id, owner_user_id")}
    GROUP BY project_id, owner_user_id
  )
  SELECT
    totals.*,
    project.name AS project_name,
    COALESCE(personal_account.display_name, user.name) AS owner_name
  FROM project_totals AS totals
  INNER JOIN projects AS project ON project.id = totals.project_id
  INNER JOIN user ON user.id = totals.owner_user_id
  LEFT JOIN personal_account ON personal_account.user_id = totals.owner_user_id
  ${
    hasCursor
      ? "WHERE totals.estimated_cost_micros < ? OR (totals.estimated_cost_micros = ? AND totals.project_id < ?)"
      : ""
  }
  ORDER BY totals.estimated_cost_micros DESC, totals.project_id DESC
  LIMIT ?`;

const rankingSql = (
  ranking: WorkspaceUsageRanking,
  where: string,
  hasCursor: boolean,
) =>
  ranking === "users"
    ? userSql(where, hasCursor)
    : projectSql(where, hasCursor);

const runnerSql = (where: string) => `${costedCte(where)}
  SELECT
    runner_provider AS provider,
    runner_profile_id AS profile_id,
    runner_profile_version AS profile_version,
    runner_template AS template,
    runner_cpu_cores AS cpu_cores,
    runner_memory_mb AS memory_mb,
    runner_disk_gb AS disk_gb,
    COALESCE(SUM(duration_ms), 0) AS duration_ms,
    COUNT(*) AS events,
    SUM(CASE WHEN runner_cpu_cores IS NULL OR runner_memory_mb IS NULL
      OR runner_disk_gb IS NULL THEN 1 ELSE 0 END) AS unknown_resource_events
  FROM costed
  WHERE kind = 'runner'
  GROUP BY runner_provider, runner_profile_id, runner_profile_version, runner_template,
    runner_cpu_cores, runner_memory_mb, runner_disk_gb
  ORDER BY duration_ms DESC, template ASC`;

const priceSourcesSql = (where: string) => `${costedCte(where)}
  SELECT DISTINCT
    price_source AS source,
    price_source_version AS source_version,
    price_currency AS currency,
    price_effective_from AS effective_from,
    price_effective_to AS effective_to,
    price_fresh_until AS fresh_until
  FROM costed
  WHERE price_currency IS NOT NULL
  ORDER BY effective_from DESC, source ASC`;

const decodeRows = <S extends Schema.Top>(
  schema: S,
  rows: ReadonlyArray<unknown>,
) => Schema.decodeUnknownEffect(Schema.Array(schema))(rows);

const summaryFrom = (row: typeof SummaryRow.Type): UsageSummary => ({
  tokens: {
    input: row.input_tokens,
    output: row.output_tokens,
    cacheRead: row.cache_read_tokens,
    cacheWrite: row.cache_write_tokens,
    reasoning: row.reasoning_tokens,
    total: row.total_tokens,
    unknownEvents: row.unknown_token_events,
  },
  estimatedCost: {
    amountMicros: row.estimated_cost_micros,
    currency: "USD",
    estimated: true,
    knownEvents: row.known_cost_events,
    unknownEvents: row.unknown_cost_events,
  },
  modelTurns: row.model_turns,
  averageLatencyMs: row.average_latency_ms,
  toolDurationMs: row.tool_duration_ms,
  runnerDurationMs: row.runner_duration_ms,
  outcomes: {
    success: row.success_outcomes,
    error: row.error_outcomes,
    cancelled: row.cancelled_outcomes,
    unknown: row.unknown_outcomes,
  },
});

export const UsageRepositoryD1 = (db: D1Database) =>
  Layer.effect(
    UsageRepository,
    Effect.succeed(
      UsageRepository.of({
        record: (input, price) =>
          Effect.gen(function* () {
            const event = yield* Schema.encodeEffect(UsageEventInput)(input);
            if (price === undefined) {
              yield* run("usage.record", () =>
                db.batch([eventInsert(db, event)]),
              );
              return;
            }
            const encodedPrice =
              yield* Schema.encodeEffect(UsagePriceMetadata)(price);
            yield* run("usage.record", () =>
              db.batch([
                priceInsert(db, encodedPrice),
                eventInsert(db, event, encodedPrice),
              ]),
            );
          }),
        putPrice: (input) =>
          Effect.gen(function* () {
            const price = yield* Schema.encodeEffect(UsagePriceMetadata)(input);
            yield* run("usage.putPrice", () => priceInsert(db, price).run());
          }),
        dashboard: (ownerUserId, query) =>
          Effect.gen(function* () {
            for (const [table, id] of [
              ["projects", query.projectId],
              ["threads", query.threadId],
            ] as const) {
              if (id === undefined) continue;
              const owned = yield* run("usage.authorize", () =>
                db
                  .prepare(
                    `SELECT id FROM ${table} WHERE id = ? AND owner_user_id = ? LIMIT 1`,
                  )
                  .bind(id, ownerUserId)
                  .first(),
              );
              if (owned === null) return yield* new UsageResourceForbidden();
            }

            const { where, values } = queryParts(ownerUserId, query);
            const cursor =
              query.cursor === undefined
                ? undefined
                : yield* decodeUsageThreadCursor(query.cursor);
            const statements = [
              db.prepare(summarySql(where)).bind(...values),
              db
                .prepare(dailySql(where))
                .bind(...values, query.sqliteTimezoneModifier),
              db
                .prepare(threadSql(where, cursor !== undefined))
                .bind(
                  ...values,
                  ...(cursor === undefined
                    ? []
                    : [
                        cursor.estimatedCostMicros,
                        cursor.estimatedCostMicros,
                        cursor.threadId,
                      ]),
                  query.limit + 1,
                ),
              db.prepare(runnerSql(where)).bind(...values),
              db.prepare(priceSourcesSql(where)).bind(...values),
            ];
            const results = yield* run("usage.dashboard", () =>
              db.batch(statements),
            );
            const summaryRows = yield* decodeRows(
              SummaryRow,
              results[0]?.results ?? [],
            );
            const dailyRows = yield* decodeRows(
              DailyRow,
              results[1]?.results ?? [],
            );
            const threadRows = yield* decodeRows(
              ThreadAggregateRow,
              results[2]?.results ?? [],
            );
            const runnerRows = yield* decodeRows(
              RunnerAggregateRow,
              results[3]?.results ?? [],
            );
            const priceRows = yield* decodeRows(
              PriceSourceRow,
              results[4]?.results ?? [],
            );
            const summary = summaryRows[0];
            if (summary === undefined) {
              return yield* unavailable(
                "usage.dashboard",
                new Error("Missing aggregate row."),
              );
            }
            const visibleThreads = threadRows.slice(0, query.limit);
            const lastThread = visibleThreads.at(-1);
            const nextCursor =
              threadRows.length > query.limit && lastThread !== undefined
                ? yield* encodeUsageThreadCursor({
                    estimatedCostMicros: lastThread.estimated_cost_micros,
                    threadId: lastThread.thread_id,
                  })
                : undefined;
            return {
              range: {
                from: query.from,
                to: query.to,
                timezoneOffsetMinutes: query.timezoneOffsetMinutes,
                timezone: query.timezone,
              },
              filters: {
                ...(query.projectId === undefined
                  ? {}
                  : { projectId: query.projectId }),
                ...(query.threadId === undefined
                  ? {}
                  : { threadId: query.threadId }),
                ...(query.providerId === undefined
                  ? {}
                  : { providerId: query.providerId }),
                ...(query.modelId === undefined
                  ? {}
                  : { modelId: query.modelId }),
              },
              summary: summaryFrom(summary),
              daily: dailyRows.map((row) => ({
                day: row.day,
                totalTokens: row.total_tokens,
                unknownTokenEvents: row.unknown_token_events,
                estimatedCostMicros: row.estimated_cost_micros,
                unknownCostEvents: row.unknown_cost_events,
                averageLatencyMs: row.average_latency_ms,
                runnerDurationMs: row.runner_duration_ms,
                modelTurns: row.model_turns,
              })),
              threads: visibleThreads.map((row) => ({
                threadId: row.thread_id,
                projectId: row.project_id,
                projectName: row.project_name,
                createdAt: row.created_at,
                providerId: row.provider_id,
                modelId: row.model_id,
                profileId: row.profile_id,
                profileVersion: row.profile_version,
                totalTokens: row.total_tokens,
                unknownTokenEvents: row.unknown_token_events,
                estimatedCostMicros: row.estimated_cost_micros,
                unknownCostEvents: row.unknown_cost_events,
                averageLatencyMs: row.average_latency_ms,
                runnerDurationMs: row.runner_duration_ms,
                modelTurns: row.model_turns,
                errorEvents: row.error_events,
              })),
              runners: runnerRows.map((row) => ({
                provider: row.provider,
                profileId: row.profile_id,
                profileVersion: row.profile_version,
                template: row.template,
                cpuCores: row.cpu_cores,
                memoryMb: row.memory_mb,
                diskGb: row.disk_gb,
                durationMs: row.duration_ms,
                events: row.events,
                unknownResourceEvents: row.unknown_resource_events,
              })),
              priceSources: priceRows.map((row) => ({
                source: row.source,
                sourceVersion: row.source_version,
                currency: row.currency,
                effectiveFrom: row.effective_from,
                effectiveTo: row.effective_to,
                freshUntil: row.fresh_until,
                estimated: true,
              })),
              ...(nextCursor === undefined ? {} : { nextCursor }),
            };
          }),
        workspaceDashboard: (workspaceId, query) =>
          Effect.gen(function* () {
            for (const [statement, id] of [
              [
                `SELECT id FROM member
                 WHERE organizationId = ? AND userId = ? LIMIT 1`,
                query.userId,
              ],
              [
                `SELECT project.id
                 FROM projects AS project
                 INNER JOIN member
                   ON member.userId = project.owner_user_id
                  AND member.organizationId = ?
                 WHERE project.id = ?
                 LIMIT 1`,
                query.projectId,
              ],
            ] as const) {
              if (id === undefined) continue;
              const attributed = yield* run("usage.workspace.authorize", () =>
                db.prepare(statement).bind(workspaceId, id).first(),
              );
              if (attributed === null)
                return yield* new UsageResourceForbidden();
            }

            const { where, values } = workspaceQueryParts(workspaceId, query);
            const cursor =
              query.cursor === undefined
                ? undefined
                : yield* decodeWorkspaceUsageRankingCursor(
                    query.cursor,
                    query.ranking,
                  );
            const results = yield* run("usage.workspace.dashboard", () =>
              db.batch([
                db.prepare(summarySql(where)).bind(...values),
                db
                  .prepare(dailySql(where))
                  .bind(...values, query.sqliteTimezoneModifier),
                db
                  .prepare(
                    rankingSql(query.ranking, where, cursor !== undefined),
                  )
                  .bind(
                    ...values,
                    ...(cursor === undefined
                      ? []
                      : [
                          cursor.estimatedCostMicros,
                          cursor.estimatedCostMicros,
                          cursor.id,
                        ]),
                    query.limit + 1,
                  ),
                db.prepare(runnerSql(where)).bind(...values),
                db.prepare(priceSourcesSql(where)).bind(...values),
              ]),
            );
            const summaryRows = yield* decodeRows(
              SummaryRow,
              results[0]?.results ?? [],
            );
            const dailyRows = yield* decodeRows(
              DailyRow,
              results[1]?.results ?? [],
            );
            const runnerRows = yield* decodeRows(
              RunnerAggregateRow,
              results[3]?.results ?? [],
            );
            const priceRows = yield* decodeRows(
              PriceSourceRow,
              results[4]?.results ?? [],
            );
            const summary = summaryRows[0];
            if (summary === undefined) {
              return yield* unavailable(
                "usage.workspace.dashboard",
                new Error("Missing aggregate row."),
              );
            }

            const range = {
              from: query.from,
              to: query.to,
              timezoneOffsetMinutes: query.timezoneOffsetMinutes,
              timezone: query.timezone,
            };
            const filters = {
              ...(query.userId === undefined ? {} : { userId: query.userId }),
              ...(query.projectId === undefined
                ? {}
                : { projectId: query.projectId }),
              ...(query.providerId === undefined
                ? {}
                : { providerId: query.providerId }),
              ...(query.modelId === undefined
                ? {}
                : { modelId: query.modelId }),
            };
            const daily = dailyRows.map((row) => ({
              day: row.day,
              totalTokens: row.total_tokens,
              unknownTokenEvents: row.unknown_token_events,
              estimatedCostMicros: row.estimated_cost_micros,
              unknownCostEvents: row.unknown_cost_events,
              averageLatencyMs: row.average_latency_ms,
              runnerDurationMs: row.runner_duration_ms,
              modelTurns: row.model_turns,
            }));
            const runners = runnerRows.map((row) => ({
              provider: row.provider,
              profileId: row.profile_id,
              profileVersion: row.profile_version,
              template: row.template,
              cpuCores: row.cpu_cores,
              memoryMb: row.memory_mb,
              diskGb: row.disk_gb,
              durationMs: row.duration_ms,
              events: row.events,
              unknownResourceEvents: row.unknown_resource_events,
            }));
            const priceSources = priceRows.map((row) => ({
              source: row.source,
              sourceVersion: row.source_version,
              currency: row.currency,
              effectiveFrom: row.effective_from,
              effectiveTo: row.effective_to,
              freshUntil: row.fresh_until,
              estimated: true as const,
            }));
            const base = {
              range,
              filters,
              summary: summaryFrom(summary),
              daily,
              runners,
              priceSources,
            };

            if (query.ranking === "users") {
              const decoded = yield* decodeRows(
                UserAggregateRow,
                results[2]?.results ?? [],
              );
              const visible = decoded.slice(0, query.limit);
              const last = visible.at(-1);
              const nextCursor =
                decoded.length > query.limit && last !== undefined
                  ? yield* encodeWorkspaceUsageRankingCursor({
                      ranking: query.ranking,
                      estimatedCostMicros: last.estimated_cost_micros,
                      id: last.user_id,
                    })
                  : undefined;
              return {
                ...base,
                ranking: {
                  kind: query.ranking,
                  items: visible.map((row) => ({
                    userId: row.user_id,
                    userName: row.user_name,
                    totalTokens: row.total_tokens,
                    unknownTokenEvents: row.unknown_token_events,
                    estimatedCostMicros: row.estimated_cost_micros,
                    unknownCostEvents: row.unknown_cost_events,
                    averageLatencyMs: row.average_latency_ms,
                    runnerDurationMs: row.runner_duration_ms,
                    modelTurns: row.model_turns,
                    errorEvents: row.error_events,
                  })),
                  ...(nextCursor === undefined ? {} : { nextCursor }),
                },
              };
            }
            const decoded = yield* decodeRows(
              ProjectAggregateRow,
              results[2]?.results ?? [],
            );
            const visible = decoded.slice(0, query.limit);
            const last = visible.at(-1);
            const nextCursor =
              decoded.length > query.limit && last !== undefined
                ? yield* encodeWorkspaceUsageRankingCursor({
                    ranking: query.ranking,
                    estimatedCostMicros: last.estimated_cost_micros,
                    id: last.project_id,
                  })
                : undefined;
            return {
              ...base,
              ranking: {
                kind: query.ranking,
                items: visible.map((row) => ({
                  projectId: row.project_id,
                  projectName: row.project_name,
                  ownerUserId: row.owner_user_id,
                  ownerName: row.owner_name,
                  totalTokens: row.total_tokens,
                  unknownTokenEvents: row.unknown_token_events,
                  estimatedCostMicros: row.estimated_cost_micros,
                  unknownCostEvents: row.unknown_cost_events,
                  averageLatencyMs: row.average_latency_ms,
                  runnerDurationMs: row.runner_duration_ms,
                  modelTurns: row.model_turns,
                  errorEvents: row.error_events,
                })),
                ...(nextCursor === undefined ? {} : { nextCursor }),
              },
            };
          }),
      }),
    ),
  );
