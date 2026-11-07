import type { NormalizedUsageQuery, UserId } from "@dx/domain";

/**
 * Read and backfill side of the usage rollups (migration 0125):
 * `usage_hourly` holds each owner's usage_event sums per UTC hour, and
 * `usage_thread_daily` per Thread and UTC day. The personal usage page reads
 * them for every whole bucket in its range and reads raw events only where a
 * bucket cannot answer exactly:
 *
 * - the partial hours (or days) at the range's two ends, when the time zone
 *   puts local midnight off the UTC hour (or day);
 * - for the per-day series, each hour holding a local midnight, since its
 *   events fall on two local days;
 * - for price sources, each hour a price window starts or ends inside, since
 *   its events can match different prices.
 *
 * Each statement returns the same rows, in the same order, as the raw query
 * it replaces (`repository-d1.ts`). The key and measure expressions below
 * must match the triggers in migration 0125.
 */

export const HOUR_MS = 3_600_000;
/** More providers and models than a person uses in a range. */
export const MODEL_BREAKDOWN_LIMIT = 50;
export const DAY_MS = 86_400_000;

const floorTo = (ms: number, unit: number) => Math.floor(ms / unit) * unit;
const ceilTo = (ms: number, unit: number) => Math.ceil(ms / unit) * unit;
const iso = (ms: number) => new Date(ms).toISOString();

export interface Buckets {
  /** Whole buckets read from the rollup: [from, to). */
  readonly from: string;
  readonly to: string;
  /** Hours inside [from, to) read raw instead, as a JSON array. */
  readonly skipped: string;
  /** Raw [from, to) spans, as a JSON array of pairs. */
  readonly raw: string;
}

export const buckets = (
  fromMs: number,
  toMs: number,
  unit: number,
  splitAt: ReadonlyArray<number>,
): Buckets => {
  const first = ceilTo(fromMs, unit);
  const last = floorTo(toMs, unit);
  if (first >= last)
    return {
      from: iso(fromMs),
      to: iso(fromMs),
      skipped: "[]",
      raw: JSON.stringify([[iso(fromMs), iso(toMs)]]),
    };
  const skipped = splitAt
    .filter((at) => at % unit !== 0)
    .map((at) => floorTo(at, unit))
    .filter((start) => start >= first && start < last);
  const raw: Array<readonly [number, number]> = [];
  if (fromMs < first) raw.push([fromMs, first]);
  for (const start of skipped) raw.push([start, start + unit]);
  if (last < toMs) raw.push([last, toMs]);
  return {
    from: iso(first),
    to: iso(last),
    skipped: JSON.stringify(skipped.map(iso)),
    raw: JSON.stringify(raw.map(([from, to]) => [iso(from), iso(to)])),
  };
};

/** The hours the per-day series must read raw: each local midnight inside. */
const hourBuckets = (query: NormalizedUsageQuery) => {
  const fromMs = Date.parse(query.fromInclusive);
  const toMs = Date.parse(query.toExclusive);
  const midnights: Array<number> = [];
  for (let at = fromMs + DAY_MS; at < toMs; at += DAY_MS) midnights.push(at);
  return buckets(fromMs, toMs, HOUR_MS, midnights);
};

const dayBuckets = (query: NormalizedUsageQuery) =>
  buckets(
    Date.parse(query.fromInclusive),
    Date.parse(query.toExclusive),
    DAY_MS,
    [],
  );

export type Column = readonly [name: string, expression: string];

export const provider = (e: string) =>
  `COALESCE(${e}.observed_provider_id, ${e}.provider_id)`;
export const model = (e: string) =>
  `COALESCE(${e}.observed_model_id, ${e}.model_id)`;
export const fresh = (e: string, column: string) =>
  `CASE WHEN ${e}.price_status = 'fresh' THEN COALESCE(${e}.${column}, '') ELSE '' END`;
const runner = (e: string, value: string, otherwise: string) =>
  `CASE WHEN ${e}.kind = 'runner' THEN ${value} ELSE ${otherwise} END`;

/** usage_hourly's key after owner and hour. */
export const hourlyKeys = (e: string): ReadonlyArray<Column> => [
  ["kind", `${e}.kind`],
  ["provider_id", provider(e)],
  ["model_id", model(e)],
  ["price_source", fresh(e, "price_source")],
  ["price_source_version", fresh(e, "price_source_version")],
  ["price_fresh_until", fresh(e, "price_fresh_until")],
  ["runner_provider", runner(e, `COALESCE(${e}.runner_provider, '')`, "''")],
  ["runner_profile_id", runner(e, `json_quote(${e}.runner_profile_id)`, "''")],
  [
    "runner_profile_version",
    runner(e, `COALESCE(${e}.runner_profile_version, -1)`, "-1"),
  ],
  ["runner_template", runner(e, `COALESCE(${e}.runner_template, '')`, "''")],
  ["runner_cpu_cores", runner(e, `COALESCE(${e}.runner_cpu_cores, -1)`, "-1")],
  ["runner_memory_mb", runner(e, `COALESCE(${e}.runner_memory_mb, -1)`, "-1")],
  ["runner_disk_gb", runner(e, `COALESCE(${e}.runner_disk_gb, -1)`, "-1")],
];

/** usage_hourly's sums, as each event contributes to them. */
export const hourlyMeasures = (e: string): ReadonlyArray<Column> => [
  ["events", "1"],
  ["success_events", `${e}.outcome = 'success'`],
  ["error_events", `${e}.outcome = 'error'`],
  ["cancelled_events", `${e}.outcome = 'cancelled'`],
  ["unknown_outcome_events", `${e}.outcome = 'unknown'`],
  ["input_tokens", `COALESCE(${e}.input_tokens, 0)`],
  ["output_tokens", `COALESCE(${e}.output_tokens, 0)`],
  ["cache_read_tokens", `COALESCE(${e}.cache_read_tokens, 0)`],
  ["cache_write_tokens", `COALESCE(${e}.cache_write_tokens, 0)`],
  ["reasoning_tokens", `COALESCE(${e}.reasoning_tokens, 0)`],
  ["reasoning_events", `${e}.reasoning_tokens IS NOT NULL`],
  ["total_tokens", `COALESCE(${e}.total_tokens, 0)`],
  ["unknown_token_events", `${e}.total_tokens IS NULL`],
  ["estimated_cost_micros", `COALESCE(${e}.estimated_cost_micros_snapshot, 0)`],
  ["known_cost_events", `${e}.estimated_cost_micros_snapshot IS NOT NULL`],
  ["duration_ms", `COALESCE(${e}.duration_ms, 0)`],
  ["duration_events", `${e}.duration_ms IS NOT NULL`],
];

/** usage_thread_daily's key after owner and day. */
const dailyKeys = (e: string): ReadonlyArray<Column> => [
  ["thread_id", `${e}.thread_id`],
  ["project_id", `${e}.project_id`],
  ["kind", `${e}.kind`],
  ["provider_id", provider(e)],
  ["model_id", model(e)],
  ["model_profile_id", `${e}.model_profile_id`],
  ["model_profile_version", `${e}.model_profile_version`],
];

const dailyMeasures = (e: string): ReadonlyArray<Column> =>
  hourlyMeasures(e).filter(([name]) =>
    [
      "events",
      "error_events",
      "total_tokens",
      "unknown_token_events",
      "estimated_cost_micros",
      "known_cost_events",
      "duration_ms",
      "duration_events",
    ].includes(name),
  );

export const names = (columns: ReadonlyArray<Column>) =>
  columns.map(([name]) => name).join(", ");
export const aliased = (columns: ReadonlyArray<Column>) =>
  columns.map(([name, expression]) => `${expression} AS ${name}`).join(", ");

interface Filter {
  readonly ownerUserId: UserId;
  readonly providerId: string | undefined;
  readonly modelId: string | undefined;
}

const filterOf = (
  ownerUserId: UserId,
  query: NormalizedUsageQuery,
): Filter => ({
  ownerUserId,
  providerId: query.providerId,
  modelId: query.modelId,
});

/** The rollup path serves queries without a Project or Thread filter. */
export const usageRollupServes = (query: NormalizedUsageQuery) =>
  query.projectId === undefined && query.threadId === undefined;

interface Part {
  readonly sql: string;
  readonly values: ReadonlyArray<unknown>;
}

const modelFilters = (
  filter: Filter,
  providerColumn: string,
  modelColumn: string,
): Part => {
  const clauses: Array<string> = [];
  const values: Array<unknown> = [];
  if (filter.providerId !== undefined) {
    clauses.push(`AND ${providerColumn} = ?`);
    values.push(filter.providerId);
  }
  if (filter.modelId !== undefined) {
    clauses.push(`AND ${modelColumn} = ?`);
    values.push(filter.modelId);
  }
  return { sql: clauses.join(" "), values };
};

/** Raw events of the owner inside the spans, after the model filters. */
const rawEvents = (filter: Filter, spans: string): Part => {
  const models = modelFilters(filter, provider("event"), model("event"));
  return {
    sql: `FROM json_each(?) AS span
      CROSS JOIN usage_event AS event
      WHERE event.owner_user_id = ?
        AND event.occurred_at >= json_extract(span.value, '$[0]')
        AND event.occurred_at < json_extract(span.value, '$[1]')
        ${models.sql}`,
    values: [spans, filter.ownerUserId, ...models.values],
  };
};

/**
 * One row per rollup bucket or raw event, with usage_hourly's columns and
 * `at`: the bucket's hour, or the event's time.
 */
const hourlyUsage = (filter: Filter, hours: Buckets): Part => {
  const models = modelFilters(filter, "rollup.provider_id", "rollup.model_id");
  const raw = rawEvents(filter, hours.raw);
  const columns = [...hourlyKeys("event"), ...hourlyMeasures("event")];
  return {
    sql: `usage AS (
      SELECT rollup.hour AS at, ${names(columns)}
      FROM usage_hourly AS rollup
      WHERE rollup.owner_user_id = ?
        AND rollup.hour >= ? AND rollup.hour < ?
        AND rollup.hour NOT IN (SELECT value FROM json_each(?))
        ${models.sql}
      UNION ALL
      SELECT event.occurred_at AS at, ${aliased(columns)}
      ${raw.sql}
    )`,
    values: [
      filter.ownerUserId,
      hours.from,
      hours.to,
      hours.skipped,
      ...models.values,
      ...raw.values,
    ],
  };
};

const modelSum = (column: string) =>
  `COALESCE(SUM(CASE WHEN kind = 'model' THEN ${column} ELSE 0 END), 0)`;
// SQLite's AVG over integers is their sum as a double over their count.
const averageModelLatency = `CAST(SUM(CASE WHEN kind = 'model' THEN duration_ms END) AS REAL)
  / SUM(CASE WHEN kind = 'model' THEN duration_events END)`;

/**
 * The summary, with `rollups_ready`: 0 until the backfill of events stored
 * before migration 0125 finishes, when the caller reads raw events instead.
 */
const summaryStatement = (filter: Filter, hours: Buckets): Part => {
  const usage = hourlyUsage(filter, hours);
  return {
    sql: `WITH ${usage.sql}
      SELECT
        ${modelSum("input_tokens")} AS input_tokens,
        ${modelSum("output_tokens")} AS output_tokens,
        ${modelSum("cache_read_tokens")} AS cache_read_tokens,
        ${modelSum("cache_write_tokens")} AS cache_write_tokens,
        CASE WHEN SUM(CASE WHEN kind = 'model' THEN reasoning_events ELSE 0 END) > 0
          THEN SUM(CASE WHEN kind = 'model' THEN reasoning_tokens ELSE 0 END) END AS reasoning_tokens,
        ${modelSum("total_tokens")} AS total_tokens,
        ${modelSum("unknown_token_events")} AS unknown_token_events,
        ${modelSum("estimated_cost_micros")} AS estimated_cost_micros,
        ${modelSum("known_cost_events")} AS known_cost_events,
        ${modelSum("events - known_cost_events")} AS unknown_cost_events,
        ${modelSum("events")} AS model_turns,
        ${averageModelLatency} AS average_latency_ms,
        COALESCE(SUM(CASE WHEN kind = 'tool' THEN duration_ms ELSE 0 END), 0) AS tool_duration_ms,
        COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
        COALESCE(SUM(success_events), 0) AS success_outcomes,
        COALESCE(SUM(error_events), 0) AS error_outcomes,
        COALESCE(SUM(cancelled_events), 0) AS cancelled_outcomes,
        COALESCE(SUM(unknown_outcome_events), 0) AS unknown_outcomes,
        (SELECT through_rowid >= end_rowid FROM usage_rollup_backfill) AS rollups_ready
      FROM usage`,
    values: usage.values,
  };
};

const dailyStatement = (
  filter: Filter,
  hours: Buckets,
  timezoneModifier: string,
): Part => {
  const usage = hourlyUsage(filter, hours);
  return {
    sql: `WITH ${usage.sql}
      SELECT
        date(at, ?) AS day,
        ${modelSum("total_tokens")} AS total_tokens,
        ${modelSum("unknown_token_events")} AS unknown_token_events,
        ${modelSum("estimated_cost_micros")} AS estimated_cost_micros,
        ${modelSum("events - known_cost_events")} AS unknown_cost_events,
        ${averageModelLatency} AS average_latency_ms,
        COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
        ${modelSum("events")} AS model_turns
      FROM usage
      GROUP BY day
      ORDER BY day ASC`,
    values: [...usage.values, timezoneModifier],
  };
};

const runnerStatement = (filter: Filter, hours: Buckets): Part => {
  const usage = hourlyUsage(filter, hours);
  return {
    sql: `WITH ${usage.sql}
      SELECT
        runner_provider AS provider,
        json_extract(runner_profile_id, '$') AS profile_id,
        NULLIF(runner_profile_version, -1) AS profile_version,
        runner_template AS template,
        NULLIF(runner_cpu_cores, -1) AS cpu_cores,
        NULLIF(runner_memory_mb, -1) AS memory_mb,
        NULLIF(runner_disk_gb, -1) AS disk_gb,
        COALESCE(SUM(duration_ms), 0) AS duration_ms,
        SUM(events) AS events,
        SUM(CASE WHEN runner_cpu_cores = -1 OR runner_memory_mb = -1
          OR runner_disk_gb = -1 THEN events ELSE 0 END) AS unknown_resource_events
      FROM usage
      WHERE kind = 'runner'
      GROUP BY runner_provider, runner_profile_id, runner_profile_version, runner_template,
        runner_cpu_cores, runner_memory_mb, runner_disk_gb
      ORDER BY duration_ms DESC, template ASC`,
    values: usage.values,
  };
};

/** The usage_price row the raw query's join picks for one key at one time. */
export const priceAt = (key: {
  readonly provider: string;
  readonly model: string;
  readonly source: string;
  readonly version: string;
  readonly freshUntil: string;
  readonly at: string;
}) => `(
  SELECT candidate.rowid
  FROM usage_price AS candidate
  WHERE candidate.provider_id = ${key.provider}
    AND candidate.model_id = ${key.model}
    AND candidate.source = ${key.source}
    AND candidate.source_version = ${key.version}
    AND candidate.effective_from <= ${key.at}
    AND (candidate.effective_to IS NULL OR ${key.at} < candidate.effective_to)
    AND candidate.fresh_until = ${key.freshUntil}
  ORDER BY
    CASE candidate.source WHEN 'deployment' THEN 0 ELSE 1 END,
    candidate.effective_from DESC,
    candidate.source_version DESC
  LIMIT 1
)`;

const eventPrice = priceAt({
  provider: provider("event"),
  model: model("event"),
  source: "event.price_source",
  version: "event.price_source_version",
  freshUntil: "event.price_fresh_until",
  at: "event.occurred_at",
});

/**
 * Price sources. Every fresh event of a rollup hour picks the same price
 * unless a candidate's window starts or ends strictly inside the hour; those
 * hours, and the raw spans, pick per event as the raw query does.
 */
const priceSourcesStatement = (filter: Filter, hours: Buckets): Part => {
  const models = modelFilters(filter, "rollup.provider_id", "rollup.model_id");
  const raw = rawEvents(filter, hours.raw);
  return {
    sql: `WITH priced AS (
        SELECT DISTINCT
          rollup.hour, strftime('%Y-%m-%dT%H:%M:%fZ', rollup.hour, '+1 hour') AS hour_end,
          rollup.provider_id, rollup.model_id,
          rollup.price_source, rollup.price_source_version, rollup.price_fresh_until
        FROM usage_hourly AS rollup
        WHERE rollup.owner_user_id = ?
          AND rollup.hour >= ? AND rollup.hour < ?
          AND rollup.hour NOT IN (SELECT value FROM json_each(?))
          AND rollup.price_source <> ''
          ${models.sql}
      ), bounded AS (
        SELECT priced.*, EXISTS (
          SELECT 1 FROM usage_price AS bound
          WHERE bound.provider_id = priced.provider_id
            AND bound.model_id = priced.model_id
            AND bound.source = priced.price_source
            AND bound.source_version = priced.price_source_version
            AND bound.fresh_until = priced.price_fresh_until
            AND (
              (bound.effective_from > priced.hour AND bound.effective_from < priced.hour_end)
              OR (bound.effective_to > priced.hour AND bound.effective_to < priced.hour_end)
            )
        ) AS split
        FROM priced
      ), chosen AS (
        SELECT ${priceAt({
          provider: "bounded.provider_id",
          model: "bounded.model_id",
          source: "bounded.price_source",
          version: "bounded.price_source_version",
          freshUntil: "bounded.price_fresh_until",
          at: "bounded.hour",
        })} AS price_rowid
        FROM bounded
        WHERE NOT bounded.split
        UNION ALL
        SELECT ${eventPrice}
        FROM bounded
        CROSS JOIN usage_event AS event
        WHERE bounded.split
          AND event.owner_user_id = ?
          AND event.occurred_at >= bounded.hour
          AND event.occurred_at < bounded.hour_end
          AND event.price_status = 'fresh'
          AND ${provider("event")} = bounded.provider_id
          AND ${model("event")} = bounded.model_id
          AND event.price_source = bounded.price_source
          AND event.price_source_version = bounded.price_source_version
          AND event.price_fresh_until = bounded.price_fresh_until
        UNION ALL
        SELECT ${eventPrice}
        ${raw.sql}
          AND event.price_status = 'fresh'
      )
      SELECT DISTINCT
        price.source AS source,
        price.source_version AS source_version,
        price.currency AS currency,
        price.effective_from AS effective_from,
        price.effective_to AS effective_to,
        price.fresh_until AS fresh_until
      FROM chosen
      INNER JOIN usage_price AS price ON price.rowid = chosen.price_rowid
      ORDER BY effective_from DESC, source ASC`,
    values: [
      filter.ownerUserId,
      hours.from,
      hours.to,
      hours.skipped,
      ...models.values,
      filter.ownerUserId,
      ...raw.values,
    ],
  };
};

const threadStatement = (
  filter: Filter,
  days: Buckets,
  cursor:
    | { readonly estimatedCostMicros: number; readonly threadId: string }
    | undefined,
  limit: number,
): Part => {
  const models = modelFilters(filter, "rollup.provider_id", "rollup.model_id");
  const raw = rawEvents(filter, days.raw);
  const columns = [...dailyKeys("event"), ...dailyMeasures("event")];
  return {
    sql: `WITH usage AS (
        SELECT ${names(columns)}
        FROM usage_thread_daily AS rollup
        WHERE rollup.owner_user_id = ?
          AND rollup.day >= ? AND rollup.day < ?
          ${models.sql}
        UNION ALL
        SELECT ${aliased(columns)}
        ${raw.sql}
      ), thread_totals AS (
        SELECT
          thread_id,
          project_id,
          MAX(provider_id) AS provider_id,
          MAX(model_id) AS model_id,
          MAX(model_profile_id) AS profile_id,
          MAX(model_profile_version) AS profile_version,
          ${modelSum("total_tokens")} AS total_tokens,
          ${modelSum("unknown_token_events")} AS unknown_token_events,
          ${modelSum("estimated_cost_micros")} AS estimated_cost_micros,
          ${modelSum("events - known_cost_events")} AS unknown_cost_events,
          ${averageModelLatency} AS average_latency_ms,
          COALESCE(SUM(CASE WHEN kind = 'runner' THEN duration_ms ELSE 0 END), 0) AS runner_duration_ms,
          ${modelSum("events")} AS model_turns,
          COALESCE(SUM(error_events), 0) AS error_events
        FROM usage
        GROUP BY thread_id, project_id
      )
      SELECT
        totals.*,
        project.name AS project_name,
        thread.title,
        thread.created_at
      FROM thread_totals AS totals
      INNER JOIN threads AS thread ON thread.id = totals.thread_id
      INNER JOIN projects AS project ON project.id = totals.project_id
      ${
        cursor === undefined
          ? ""
          : "WHERE totals.estimated_cost_micros < ? OR (totals.estimated_cost_micros = ? AND totals.thread_id < ?)"
      }
      ORDER BY totals.estimated_cost_micros DESC, totals.thread_id DESC
      LIMIT ?`,
    values: [
      filter.ownerUserId,
      days.from,
      days.to,
      ...models.values,
      ...raw.values,
      ...(cursor === undefined
        ? []
        : [
            cursor.estimatedCostMicros,
            cursor.estimatedCostMicros,
            cursor.threadId,
          ]),
      limit,
    ],
  };
};

/** Model turns by provider and model, highest estimated cost first. */
const modelStatement = (filter: Filter, hours: Buckets): Part => {
  const usage = hourlyUsage(filter, hours);
  return {
    sql: `WITH ${usage.sql}
      SELECT
        provider_id,
        model_id,
        COALESCE(SUM(total_tokens), 0) AS total_tokens,
        COALESCE(SUM(unknown_token_events), 0) AS unknown_token_events,
        COALESCE(SUM(estimated_cost_micros), 0) AS estimated_cost_micros,
        COALESCE(SUM(events - known_cost_events), 0) AS unknown_cost_events,
        COALESCE(SUM(events), 0) AS model_turns
      FROM usage
      WHERE kind = 'model'
      GROUP BY provider_id, model_id
      ORDER BY estimated_cost_micros DESC, total_tokens DESC, provider_id, model_id
      LIMIT ${MODEL_BREAKDOWN_LIMIT}`,
    values: usage.values,
  };
};

/**
 * The personal dashboard's six aggregates over the rollups, in the order
 * repository-d1.ts reads them: summary, per day, Threads, runners, price
 * sources, models.
 */
export const usageRollupStatements = (
  db: D1Database,
  ownerUserId: UserId,
  query: NormalizedUsageQuery,
  cursor:
    | { readonly estimatedCostMicros: number; readonly threadId: string }
    | undefined,
): ReadonlyArray<D1PreparedStatement> => {
  const filter = filterOf(ownerUserId, query);
  const hours = hourBuckets(query);
  return [
    summaryStatement(filter, hours),
    dailyStatement(filter, hours, query.sqliteTimezoneModifier),
    threadStatement(filter, dayBuckets(query), cursor, query.limit + 1),
    runnerStatement(filter, hours),
    priceSourcesStatement(filter, hours),
    modelStatement(filter, hours),
  ].map(({ sql, values }) => db.prepare(sql).bind(...values));
};

export const upsert = (measures: ReadonlyArray<Column>) =>
  measures.map(([name]) => `${name} = ${name} + excluded.${name}`).join(", ");

export const summed = (measures: ReadonlyArray<Column>) =>
  measures.map(([, expression]) => `SUM(${expression})`).join(", ");

export const positions = (count: number) =>
  Array.from({ length: count }, (_, index) => index + 1).join(", ");

// ?1 is the chunk's start and must still be the backfill's position, so a
// chunk two runs both read adds nothing the second time; ?2 is its end.
export const backfillChunk = (
  state: string,
) => `event.rowid > ?1 AND event.rowid <= ?2
  AND (SELECT through_rowid FROM ${state}) = ?1`;
const chunk = backfillChunk("usage_rollup_backfill");

const hourlyBackfill = (() => {
  const keys = [
    ["owner_user_id", "event.owner_user_id"],
    ["hour", "substr(event.occurred_at, 1, 13) || ':00:00.000Z'"],
    ...hourlyKeys("event"),
  ] as const;
  const measures = hourlyMeasures("event");
  return `INSERT INTO usage_hourly (${names(keys)}, ${names(measures)})
    SELECT * FROM (
      SELECT ${keys.map(([, expression]) => expression).join(", ")}, ${summed(measures)}
      FROM usage_event AS event
      WHERE ${chunk}
      GROUP BY ${positions(keys.length)}
    ) WHERE true
    ORDER BY ${positions(keys.length)}
    ON CONFLICT DO UPDATE SET ${upsert(measures)}`;
})();

const dailyBackfill = (() => {
  const keys = [
    ["owner_user_id", "event.owner_user_id"],
    ["day", "substr(event.occurred_at, 1, 10) || 'T00:00:00.000Z'"],
    ...dailyKeys("event"),
  ] as const;
  const measures = dailyMeasures("event");
  return `INSERT INTO usage_thread_daily (${names(keys)}, ${names(measures)})
    SELECT * FROM (
      SELECT ${keys.map(([, expression]) => expression).join(", ")}, ${summed(measures)}
      FROM usage_event AS event
      WHERE ${chunk}
      GROUP BY ${positions(keys.length)}
    ) WHERE true
    ORDER BY ${positions(keys.length)}
    ON CONFLICT DO UPDATE SET ${upsert(measures)}`;
})();

/**
 * Adds up to `chunks` rowid chunks of the events stored before a rollup
 * migration to its rollups: `state` is its backfill table, `inserts` its
 * statements, each binding the chunk as ?1 and ?2 (`backfillChunk`). Returns
 * true once every such event is in them. A chunk of 50,000 events runs in
 * well under a second, far inside D1's 30-second limit.
 */
export const backfillRollups = async (
  db: D1Database,
  state: string,
  inserts: ReadonlyArray<string>,
  chunks: number,
  chunkRows: number,
): Promise<boolean> => {
  for (let index = 0; index < chunks; index += 1) {
    const position = await db
      .prepare(`SELECT through_rowid, end_rowid FROM ${state}`)
      .first<{ through_rowid: number; end_rowid: number }>();
    if (position === null) return false;
    if (position.through_rowid >= position.end_rowid) return true;
    const end = Math.min(
      position.through_rowid + chunkRows,
      position.end_rowid,
    );
    await db.batch([
      ...inserts.map((insert) =>
        db.prepare(insert).bind(position.through_rowid, end),
      ),
      db
        .prepare(
          `UPDATE ${state} SET through_rowid = ?2
           WHERE singleton = 1 AND through_rowid = ?1`,
        )
        .bind(position.through_rowid, end),
    ]);
  }
  const done = await db
    .prepare(`SELECT through_rowid >= end_rowid AS done FROM ${state}`)
    .first<{ done: number }>();
  return done?.done === 1;
};

/** Backfills migration 0125's owner rollups; see `backfillRollups`. */
export const backfillUsageRollups = (
  db: D1Database,
  chunks: number,
  chunkRows = 50_000,
): Promise<boolean> =>
  backfillRollups(
    db,
    "usage_rollup_backfill",
    [hourlyBackfill, dailyBackfill],
    chunks,
    chunkRows,
  );
