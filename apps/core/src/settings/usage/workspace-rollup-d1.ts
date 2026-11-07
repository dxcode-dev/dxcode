import type { NormalizedWorkspaceUsageQuery, WorkspaceId } from "@dx/domain";
import { activeMemberSql } from "../members/membership-sql.js";
import {
  aliased,
  type Buckets,
  backfillChunk,
  backfillRollups,
  buckets,
  type Column,
  DAY_MS,
  HOUR_MS,
  hourlyKeys,
  hourlyMeasures,
  model,
  names,
  positions,
  priceAt,
  provider,
  summed,
  upsert,
} from "./rollup-d1.js";

/**
 * Read and backfill side of the workspace usage rollups (migration 0151):
 * `usage_workspace_daily` and `usage_workspace_hourly` hold the workspace's
 * usage_event sums per member, Project, Thread, kind, model, price, and
 * runner, per UTC day and per UTC hour.
 *
 * The workspace page reads its whole range in one scan of one of them, and
 * the Worker adds the rows up into every aggregate the raw queries return
 * (`workspace-usage-aggregate.ts`). Each extra D1 query, and each sort or
 * temporary table inside one, reads the rows again, so one scan is what
 * keeps a load inside a fixed budget. Raw events are read only where a
 * bucket cannot answer exactly:
 *
 * - UTC ranges, which the page always asks for, are whole UTC days: the
 *   daily rollup answers them alone.
 * - Any other time zone reads hours: raw events for the partial hours at the
 *   range's two ends, and for each hour holding a local midnight, since its
 *   events fall on two local days.
 *
 * The key and measure expressions are migration 0125's (`rollup-d1.ts`) and
 * must match the triggers in migration 0151.
 */

export interface WorkspaceRollupPlan {
  readonly table: "usage_workspace_daily" | "usage_workspace_hourly";
  readonly bucket: "day" | "hour";
  readonly unit: "+1 day" | "+1 hour";
  readonly buckets: Buckets;
}

/** Day buckets when local days are UTC days; hour buckets otherwise. */
export const workspaceRollupPlan = (
  query: NormalizedWorkspaceUsageQuery,
): WorkspaceRollupPlan => {
  const fromMs = Date.parse(query.fromInclusive);
  const toMs = Date.parse(query.toExclusive);
  if (query.timezoneOffsetMinutes % 1440 === 0)
    return {
      table: "usage_workspace_daily",
      bucket: "day",
      unit: "+1 day",
      buckets: buckets(fromMs, toMs, DAY_MS, []),
    };
  const midnights: Array<number> = [];
  for (let at = fromMs + DAY_MS; at < toMs; at += DAY_MS) midnights.push(at);
  return {
    table: "usage_workspace_hourly",
    bucket: "hour",
    unit: "+1 hour",
    buckets: buckets(fromMs, toMs, HOUR_MS, midnights),
  };
};

/**
 * The rollup's whole buckets as [from, to) spans between the skipped ones,
 * as a JSON array of pairs. Each span is one index range: a filter that
 * skips buckets row by row would read every row twice.
 */
const rolledSpans = (rolled: Buckets, unit: number) => {
  const spans: Array<readonly [string, string]> = [];
  let from = Date.parse(rolled.from);
  const to = Date.parse(rolled.to);
  for (const skipped of (JSON.parse(rolled.skipped) as ReadonlyArray<string>)
    .map(Date.parse)
    .sort((a, b) => a - b)) {
    if (from < skipped)
      spans.push([
        new Date(from).toISOString(),
        new Date(skipped).toISOString(),
      ]);
    from = skipped + unit;
  }
  if (from < to)
    spans.push([new Date(from).toISOString(), new Date(to).toISOString()]);
  return JSON.stringify(spans);
};

interface Part {
  readonly sql: string;
  readonly values: ReadonlyArray<unknown>;
}

/** The workspace page's filters over rollup columns or raw event columns. */
const filters = (
  query: NormalizedWorkspaceUsageQuery,
  columns: {
    readonly owner: string;
    readonly project: string;
    readonly provider: string;
    readonly model: string;
  },
): Part => {
  const clauses: Array<string> = [];
  const values: Array<unknown> = [];
  for (const [column, value] of [
    [columns.owner, query.userId],
    [columns.project, query.projectId],
    [columns.provider, query.providerId],
    [columns.model, query.modelId],
  ] as const) {
    if (value === undefined) continue;
    clauses.push(`AND ${column} = ?`);
    values.push(value);
  }
  return { sql: clauses.join(" "), values };
};

const rawFilters = (query: NormalizedWorkspaceUsageQuery) =>
  filters(query, {
    owner: "event.owner_user_id",
    project: "event.project_id",
    provider: provider("event"),
    model: model("event"),
  });

const rollupFilters = (query: NormalizedWorkspaceUsageQuery) =>
  filters(query, {
    owner: "rollup.owner_user_id",
    project: "rollup.project_id",
    provider: "rollup.provider_id",
    model: "rollup.model_id",
  });

/** Columns every row carries, after `local_day`, `bucket_from`, `bucket_to`. */
const ROW_KEYS = [
  "owner_user_id",
  "project_id",
  "thread_id",
  "kind",
  "provider_id",
  "model_id",
  "price_source",
  "price_source_version",
  "price_fresh_until",
] as const;

const measureNames = hourlyMeasures("event").map(([name]) => name);

/**
 * Every rollup row and raw event of the range that passes the filters, with
 * its local day and the bucket (or raw span) it came from. Runner columns are
 * decoded back to the event's values; they mean something only for runners.
 */
export const workspaceUsageRowsStatement = (
  db: D1Database,
  workspaceId: WorkspaceId,
  query: NormalizedWorkspaceUsageQuery,
  plan: WorkspaceRollupPlan,
): D1PreparedStatement => {
  const rolled = rollupFilters(query);
  const raw = rawFilters(query);
  const rawKeys = hourlyKeys("event").filter(([name]) =>
    (ROW_KEYS as ReadonlyArray<string>).includes(name),
  );
  const rawColumns: ReadonlyArray<Column> = [
    ["owner_user_id", "event.owner_user_id"],
    ["project_id", "event.project_id"],
    ["thread_id", "event.thread_id"],
    ...rawKeys,
    ["runner_provider", "event.runner_provider"],
    ["runner_profile_id", "event.runner_profile_id"],
    ["runner_profile_version", "event.runner_profile_version"],
    ["runner_template", "event.runner_template"],
    ["runner_cpu_cores", "event.runner_cpu_cores"],
    ["runner_memory_mb", "event.runner_memory_mb"],
    ["runner_disk_gb", "event.runner_disk_gb"],
    ...hourlyMeasures("event"),
    ["first_at", "event.occurred_at"],
    ["last_at", "event.occurred_at"],
  ];
  const sql = `
    SELECT
      date(rollup.${plan.bucket}, ?) AS local_day,
      rollup.${plan.bucket} AS bucket_from,
      strftime('%Y-%m-%dT%H:%M:%fZ', rollup.${plan.bucket}, '${plan.unit}') AS bucket_to,
      ${ROW_KEYS.map((name) => `rollup.${name}`).join(", ")},
      rollup.runner_provider,
      CASE WHEN rollup.kind = 'runner' THEN json_extract(rollup.runner_profile_id, '$') END AS runner_profile_id,
      NULLIF(rollup.runner_profile_version, -1) AS runner_profile_version,
      rollup.runner_template,
      NULLIF(rollup.runner_cpu_cores, -1) AS runner_cpu_cores,
      NULLIF(rollup.runner_memory_mb, -1) AS runner_memory_mb,
      NULLIF(rollup.runner_disk_gb, -1) AS runner_disk_gb,
      ${measureNames.map((name) => `rollup.${name}`).join(", ")},
      rollup.first_at,
      rollup.last_at
    FROM json_each(?) AS span
    CROSS JOIN ${plan.table} AS rollup
    WHERE rollup.workspace_id = ?
      AND rollup.${plan.bucket} >= json_extract(span.value, '$[0]')
      AND rollup.${plan.bucket} < json_extract(span.value, '$[1]')
      ${rolled.sql}
    UNION ALL
    SELECT
      date(event.occurred_at, ?) AS local_day,
      json_extract(span.value, '$[0]') AS bucket_from,
      json_extract(span.value, '$[1]') AS bucket_to,
      ${aliased(rawColumns)}
    FROM json_each(?) AS span
    CROSS JOIN usage_event AS event
    WHERE event.workspace_id = ?
      AND event.occurred_at >= json_extract(span.value, '$[0]')
      AND event.occurred_at < json_extract(span.value, '$[1]')
      ${raw.sql}`;
  return db
    .prepare(sql)
    .bind(
      query.sqliteTimezoneModifier,
      rolledSpans(plan.buckets, plan.bucket === "day" ? DAY_MS : HOUR_MS),
      workspaceId,
      ...rolled.values,
      query.sqliteTimezoneModifier,
      plan.buckets.raw,
      workspaceId,
      ...raw.values,
    );
};

/** Whether the backfill of events stored before migration 0151 is done. */
export const workspaceRollupReadyStatement = (db: D1Database) =>
  db.prepare(
    "SELECT through_rowid >= end_rowid AS ready FROM usage_workspace_rollup_backfill",
  );

/**
 * A fresh-priced key's events in one bucket or raw span, bounded by the
 * earliest and latest event time the rollup recorded.
 */
export type PriceProbeBucket = readonly [
  from: string,
  to: string,
  firstAt: string,
  lastAt: string,
];

/** One price key's events across the range, and its buckets. */
export type PriceProbe = readonly [
  providerId: string,
  modelId: string,
  source: string,
  sourceVersion: string,
  freshUntil: string,
  firstAt: string,
  lastAt: string,
  buckets: ReadonlyArray<PriceProbeBucket>,
];

/** A usage_price window starts or ends after `first` and at most at `last`. */
const priceBoundary = (probe: string) => `EXISTS (
  SELECT 1 FROM usage_price AS bound
  WHERE bound.provider_id = ${probe}.provider_id
    AND bound.model_id = ${probe}.model_id
    AND bound.source = ${probe}.source
    AND bound.source_version = ${probe}.source_version
    AND bound.fresh_until = ${probe}.fresh_until
    AND (
      (bound.effective_from > ${probe}.first_at AND bound.effective_from <= ${probe}.last_at)
      OR (bound.effective_to > ${probe}.first_at AND bound.effective_to <= ${probe}.last_at)
    )
)`;

const probePrice = (probe: string) =>
  priceAt({
    provider: `${probe}.provider_id`,
    model: `${probe}.model_id`,
    source: `${probe}.source`,
    version: `${probe}.source_version`,
    freshUntil: `${probe}.fresh_until`,
    at: `${probe}.first_at`,
  });

/**
 * The price sources the raw query's per-event join picks. The join picks by
 * the event's key and time, and its pick changes only where a matching
 * usage_price window starts or ends. A key with no such boundary between its
 * earliest and latest event picks one price for all of them; a key with one
 * is checked bucket by bucket, and only a bucket with a boundary inside is
 * priced event by event, from raw events.
 */
export const workspacePriceSourcesStatement = (
  db: D1Database,
  workspaceId: WorkspaceId,
  query: NormalizedWorkspaceUsageQuery,
  probes: ReadonlyArray<PriceProbe>,
): D1PreparedStatement => {
  const raw = rawFilters(query);
  const eventPrice = priceAt({
    provider: provider("event"),
    model: model("event"),
    source: "event.price_source",
    version: "event.price_source_version",
    freshUntil: "event.price_fresh_until",
    at: "event.occurred_at",
  });
  const sql = `
    WITH probe AS (
      SELECT
        json_extract(value, '$[0]') AS provider_id,
        json_extract(value, '$[1]') AS model_id,
        json_extract(value, '$[2]') AS source,
        json_extract(value, '$[3]') AS source_version,
        json_extract(value, '$[4]') AS fresh_until,
        json_extract(value, '$[5]') AS first_at,
        json_extract(value, '$[6]') AS last_at,
        json_extract(value, '$[7]') AS buckets
      FROM json_each(?)
    ), keyed AS (
      SELECT probe.*, ${priceBoundary("probe")} AS split FROM probe
    ), bucketed AS (
      SELECT
        keyed.provider_id, keyed.model_id, keyed.source,
        keyed.source_version, keyed.fresh_until,
        json_extract(bucket.value, '$[0]') AS bucket_from,
        json_extract(bucket.value, '$[1]') AS bucket_to,
        json_extract(bucket.value, '$[2]') AS first_at,
        json_extract(bucket.value, '$[3]') AS last_at
      FROM keyed CROSS JOIN json_each(keyed.buckets) AS bucket
      WHERE keyed.split
    ), checked AS (
      SELECT bucketed.*, ${priceBoundary("bucketed")} AS split FROM bucketed
    ), chosen AS (
      SELECT ${probePrice("keyed")} AS price_rowid FROM keyed WHERE NOT keyed.split
      UNION ALL
      SELECT ${probePrice("checked")} FROM checked WHERE NOT checked.split
      UNION ALL
      SELECT ${eventPrice}
      FROM checked CROSS JOIN usage_event AS event
      WHERE checked.split
        AND event.workspace_id = ?
        AND event.occurred_at >= checked.bucket_from
        AND event.occurred_at < checked.bucket_to
        AND event.price_status = 'fresh'
        AND ${provider("event")} = checked.provider_id
        AND ${model("event")} = checked.model_id
        AND event.price_source = checked.source
        AND event.price_source_version = checked.source_version
        AND event.price_fresh_until = checked.fresh_until
        ${raw.sql}
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
    ORDER BY effective_from DESC, source ASC`;
  return db
    .prepare(sql)
    .bind(JSON.stringify(probes), workspaceId, ...raw.values);
};

/** Display names of the listed users that still exist. */
export const workspaceUserNamesStatement = (
  db: D1Database,
  userIds: ReadonlyArray<string>,
) =>
  db
    .prepare(
      `SELECT user.id AS user_id,
         COALESCE(personal_account.display_name, user.name) AS user_name
       FROM json_each(?) AS wanted
       INNER JOIN user ON user.id = wanted.value
       LEFT JOIN personal_account ON personal_account.user_id = user.id`,
    )
    .bind(JSON.stringify(userIds));

/** Names of the listed Projects that still exist. */
export const workspaceProjectNamesStatement = (
  db: D1Database,
  projectIds: ReadonlyArray<string>,
) =>
  db
    .prepare(
      `SELECT project.id AS project_id, project.name AS project_name
       FROM json_each(?) AS wanted
       INNER JOIN projects AS project ON project.id = wanted.value`,
    )
    .bind(JSON.stringify(projectIds));

/** A Thread's model use over the range, most expensive first. */
export type ThreadCandidate = readonly [
  threadId: string,
  ownerUserId: string,
  totalTokens: number,
  estimatedCostMicros: number,
  unknownCostEvents: number,
  modelTurns: number,
];

const WORKSPACE_THREAD_LIMIT = 10;

/**
 * The first ten candidates, in their order, that are shared with this
 * workspace by an owner who is still an active member: the raw query's
 * Thread list (`workspaceThreadSql`). Binds the candidates, then the
 * workspace.
 */
const listedThreads = `
  SELECT
    json_extract(candidate.value, '$[0]') AS thread_id,
    json_extract(candidate.value, '$[1]') AS owner_user_id,
    json_extract(candidate.value, '$[2]') AS total_tokens,
    json_extract(candidate.value, '$[3]') AS estimated_cost_micros,
    json_extract(candidate.value, '$[4]') AS unknown_cost_events,
    json_extract(candidate.value, '$[5]') AS model_turns,
    thread.title,
    thread.created_at,
    COALESCE(personal_account.display_name, user.name) AS owner_name
  FROM json_each(?) AS candidate
  INNER JOIN threads AS thread
    ON thread.id = json_extract(candidate.value, '$[0]')
   AND thread.visibility = 'workspace'
   AND thread.workspace_access != 'none'
   AND thread.shared_workspace_id = ?
   AND thread.lifecycle_state <> 'deleted'
   AND ${activeMemberSql("thread.shared_workspace_id", "thread.owner_user_id")}
  INNER JOIN user ON user.id = json_extract(candidate.value, '$[1]')
  LEFT JOIN personal_account
    ON personal_account.user_id = json_extract(candidate.value, '$[1]')
  ORDER BY candidate.key
  LIMIT ${WORKSPACE_THREAD_LIMIT}`;

export const workspaceThreadsStatement = (
  db: D1Database,
  workspaceId: WorkspaceId,
  candidates: ReadonlyArray<ThreadCandidate>,
) => db.prepare(listedThreads).bind(JSON.stringify(candidates), workspaceId);

/**
 * The listed Threads' model use by UTC hour, for the activity strip: whole
 * hours from the hourly rollup's covering Thread index, and raw events for
 * the partial hours at the range's ends. Same rows as the raw query
 * (`threadActivitySql` in repository-d1.ts).
 */
export const workspaceThreadActivityStatement = (
  db: D1Database,
  workspaceId: WorkspaceId,
  query: NormalizedWorkspaceUsageQuery,
  threadIds: ReadonlyArray<string>,
) => {
  const hours = buckets(
    Date.parse(query.fromInclusive),
    Date.parse(query.toExclusive),
    HOUR_MS,
    [],
  );
  const listed = threadIds.map(() => "?").join(", ");
  return db
    .prepare(
      `WITH usage AS (
         SELECT rollup.thread_id, rollup.hour, rollup.total_tokens, rollup.estimated_cost_micros
         FROM usage_workspace_hourly AS rollup
           INDEXED BY usage_workspace_hourly_thread_idx
         WHERE rollup.workspace_id = ?
           AND rollup.thread_id IN (${listed})
           AND rollup.kind = 'model'
           AND rollup.hour >= ? AND rollup.hour < ?
         UNION ALL
         SELECT
           event.thread_id,
           substr(event.occurred_at, 1, 13) || ':00:00.000Z',
           COALESCE(event.total_tokens, 0),
           COALESCE(event.estimated_cost_micros_snapshot, 0)
         FROM json_each(?) AS span
         CROSS JOIN usage_event AS event
         WHERE event.workspace_id = ?
           AND event.thread_id IN (${listed})
           AND event.occurred_at >= json_extract(span.value, '$[0]')
           AND event.occurred_at < json_extract(span.value, '$[1]')
           AND event.kind = 'model'
       )
       SELECT
         thread_id,
         hour,
         COALESCE(SUM(total_tokens), 0) AS total_tokens,
         COALESCE(SUM(estimated_cost_micros), 0) AS estimated_cost_micros
       FROM usage
       GROUP BY thread_id, hour
       ORDER BY thread_id, hour`,
    )
    .bind(
      workspaceId,
      ...threadIds,
      hours.from,
      hours.to,
      hours.raw,
      workspaceId,
      ...threadIds,
    );
};

const workspaceKeys = (bucket: Column): ReadonlyArray<Column> => [
  ["workspace_id", "event.workspace_id"],
  bucket,
  ["owner_user_id", "event.owner_user_id"],
  ["project_id", "event.project_id"],
  ["thread_id", "event.thread_id"],
  ...hourlyKeys("event"),
];

const STATE = "usage_workspace_rollup_backfill";

const workspaceBackfill = (table: string, bucket: Column) => {
  const keys = workspaceKeys(bucket);
  const measures = hourlyMeasures("event");
  return `INSERT INTO ${table} (${names(keys)}, ${names(measures)}, first_at, last_at)
    SELECT * FROM (
      SELECT ${keys.map(([, expression]) => expression).join(", ")},
        ${summed(measures)}, MIN(event.occurred_at), MAX(event.occurred_at)
      FROM usage_event AS event
      WHERE ${backfillChunk(STATE)}
        AND event.workspace_id IS NOT NULL
      GROUP BY ${positions(keys.length)}
    ) WHERE true
    ORDER BY ${positions(keys.length)}
    ON CONFLICT DO UPDATE SET ${upsert(measures)},
      first_at = min(first_at, excluded.first_at),
      last_at = max(last_at, excluded.last_at)`;
};

const workspaceBackfills = [
  workspaceBackfill("usage_workspace_daily", [
    "day",
    "substr(event.occurred_at, 1, 10) || 'T00:00:00.000Z'",
  ]),
  workspaceBackfill("usage_workspace_hourly", [
    "hour",
    "substr(event.occurred_at, 1, 13) || ':00:00.000Z'",
  ]),
];

/**
 * Adds up to `chunks` rowid chunks of the events stored before migration 0151
 * to the workspace rollups; true once every such event is in them.
 */
export const backfillWorkspaceUsageRollups = (
  db: D1Database,
  chunks: number,
  chunkRows = 50_000,
): Promise<boolean> =>
  backfillRollups(db, STATE, workspaceBackfills, chunks, chunkRows);
