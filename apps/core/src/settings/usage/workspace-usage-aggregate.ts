import { Schema } from "effect";
import { MODEL_BREAKDOWN_LIMIT } from "./rollup-d1.js";
import type {
  PriceProbe,
  PriceProbeBucket,
  ThreadCandidate,
} from "./workspace-rollup-d1.js";

/**
 * Adds the workspace page's rows (`workspaceUsageRowsStatement`: rollup
 * buckets and raw events alike) up into the rows the raw queries return
 * (`repository-d1.ts`), with their values, NULLs, and order. Sums of D1
 * integers stay exact in a double far past any usage total, and SQLite's AVG
 * over integers is their integer sum over their count, as here.
 */

export const WorkspaceUsageRow = Schema.Struct({
  local_day: Schema.String,
  bucket_from: Schema.String,
  bucket_to: Schema.String,
  owner_user_id: Schema.String,
  project_id: Schema.String,
  thread_id: Schema.String,
  kind: Schema.String,
  provider_id: Schema.String,
  model_id: Schema.String,
  price_source: Schema.String,
  price_source_version: Schema.String,
  price_fresh_until: Schema.String,
  runner_provider: Schema.NullOr(Schema.String),
  runner_profile_id: Schema.NullOr(Schema.String),
  runner_profile_version: Schema.NullOr(Schema.Number),
  runner_template: Schema.NullOr(Schema.String),
  runner_cpu_cores: Schema.NullOr(Schema.Number),
  runner_memory_mb: Schema.NullOr(Schema.Number),
  runner_disk_gb: Schema.NullOr(Schema.Number),
  events: Schema.Number,
  success_events: Schema.Number,
  error_events: Schema.Number,
  cancelled_events: Schema.Number,
  unknown_outcome_events: Schema.Number,
  input_tokens: Schema.Number,
  output_tokens: Schema.Number,
  cache_read_tokens: Schema.Number,
  cache_write_tokens: Schema.Number,
  reasoning_tokens: Schema.Number,
  reasoning_events: Schema.Number,
  total_tokens: Schema.Number,
  unknown_token_events: Schema.Number,
  estimated_cost_micros: Schema.Number,
  known_cost_events: Schema.Number,
  duration_ms: Schema.Number,
  duration_events: Schema.Number,
  first_at: Schema.String,
  last_at: Schema.String,
});

export type WorkspaceUsageRow = typeof WorkspaceUsageRow.Type;

/** SQLite's BINARY order of two strings: their UTF-8 bytes, so code points. */
export const compareText = (a: string, b: string) => {
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    let x = a.charCodeAt(index);
    let y = b.charCodeAt(index);
    if (x === y) continue;
    // Surrogates encode code points above U+FFFF: after U+E000..U+FFFF.
    if (x >= 0xd800) x = x < 0xe000 ? x + 0x2000 : x - 0x800;
    if (y >= 0xd800) y = y < 0xe000 ? y + 0x2000 : y - 0x800;
    return x - y;
  }
  return a.length - b.length;
};

/** SQLite's order of values: NULL, then numbers, then text. */
const compareValue = (
  a: string | number | null,
  b: string | number | null,
): number => {
  if (a === b) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  if (typeof a === "number") return typeof b === "number" ? a - b : -1;
  return typeof b === "number" ? 1 : compareText(a, b);
};

/** The sums every aggregate of the raw queries is made of. */
class Totals {
  inputTokens = 0;
  outputTokens = 0;
  cacheReadTokens = 0;
  cacheWriteTokens = 0;
  reasoningTokens = 0;
  reasoningEvents = 0;
  totalTokens = 0;
  unknownTokenEvents = 0;
  estimatedCostMicros = 0;
  knownCostEvents = 0;
  modelTurns = 0;
  modelDurationMs = 0;
  modelDurationEvents = 0;
  toolDurationMs = 0;
  runnerDurationMs = 0;
  success = 0;
  error = 0;
  cancelled = 0;
  unknown = 0;

  add(row: WorkspaceUsageRow) {
    if (row.kind === "model") {
      this.inputTokens += row.input_tokens;
      this.outputTokens += row.output_tokens;
      this.cacheReadTokens += row.cache_read_tokens;
      this.cacheWriteTokens += row.cache_write_tokens;
      this.reasoningTokens += row.reasoning_tokens;
      this.reasoningEvents += row.reasoning_events;
      this.totalTokens += row.total_tokens;
      this.unknownTokenEvents += row.unknown_token_events;
      this.estimatedCostMicros += row.estimated_cost_micros;
      this.knownCostEvents += row.known_cost_events;
      this.modelTurns += row.events;
      this.modelDurationMs += row.duration_ms;
      this.modelDurationEvents += row.duration_events;
    } else if (row.kind === "tool") this.toolDurationMs += row.duration_ms;
    else if (row.kind === "runner") this.runnerDurationMs += row.duration_ms;
    this.success += row.success_events;
    this.error += row.error_events;
    this.cancelled += row.cancelled_events;
    this.unknown += row.unknown_outcome_events;
  }

  get unknownCostEvents() {
    return this.modelTurns - this.knownCostEvents;
  }

  get averageLatencyMs() {
    return this.modelDurationEvents === 0
      ? null
      : this.modelDurationMs / this.modelDurationEvents;
  }
}

const groupBy = <T>(
  groups: Map<string, T>,
  key: string,
  create: () => T,
): T => {
  const existing = groups.get(key);
  if (existing !== undefined) return existing;
  const created = create();
  groups.set(key, created);
  return created;
};

export interface RankingGroup {
  readonly ownerUserId: string;
  readonly projectId: string;
  readonly totals: Totals;
  readonly threads: Set<string>;
}

interface RunnerGroup {
  readonly key: ReadonlyArray<string | number | null>;
  readonly row: WorkspaceUsageRow;
  durationMs: number;
  events: number;
  unknownResourceEvents: number;
}

interface PriceGroup {
  readonly key: readonly [string, string, string, string, string];
  firstAt: string;
  lastAt: string;
  readonly buckets: Map<string, [string, string, string, string]>;
}

const minText = (a: string, b: string) => (compareText(a, b) <= 0 ? a : b);
const maxText = (a: string, b: string) => (compareText(a, b) >= 0 ? a : b);

const rankingRow = (group: RankingGroup) => ({
  thread_count: group.threads.size,
  total_tokens: group.totals.totalTokens,
  unknown_token_events: group.totals.unknownTokenEvents,
  estimated_cost_micros: group.totals.estimatedCostMicros,
  unknown_cost_events: group.totals.unknownCostEvents,
  average_latency_ms: group.totals.averageLatencyMs,
  runner_duration_ms: group.totals.runnerDurationMs,
  model_turns: group.totals.modelTurns,
  error_events: group.totals.error,
});

/** Every aggregate of the workspace page, from one pass over its rows. */
export const aggregateWorkspaceUsage = (
  rows: ReadonlyArray<WorkspaceUsageRow>,
  ranking: "users" | "projects",
) => {
  const summary = new Totals();
  const days = new Map<string, { totals: Totals; users: Set<string> }>();
  const rankings = new Map<string, RankingGroup>();
  const runners = new Map<string, RunnerGroup>();
  const models = new Map<string, { row: WorkspaceUsageRow; totals: Totals }>();
  const threads = new Map<string, { row: WorkspaceUsageRow; totals: Totals }>();
  const prices = new Map<string, PriceGroup>();

  for (const row of rows) {
    summary.add(row);
    const day = groupBy(days, row.local_day, () => ({
      totals: new Totals(),
      users: new Set<string>(),
    }));
    day.totals.add(row);
    if (row.kind === "model") day.users.add(row.owner_user_id);

    const rankingKey =
      ranking === "users"
        ? row.owner_user_id
        : `${row.project_id}\u0000${row.owner_user_id}`;
    const group = groupBy(rankings, rankingKey, () => ({
      ownerUserId: row.owner_user_id,
      projectId: row.project_id,
      totals: new Totals(),
      threads: new Set<string>(),
    }));
    group.totals.add(row);
    group.threads.add(row.thread_id);

    if (row.kind === "runner") {
      const key = [
        row.runner_provider,
        row.runner_profile_id,
        row.runner_profile_version,
        row.runner_template,
        row.runner_cpu_cores,
        row.runner_memory_mb,
        row.runner_disk_gb,
      ] as const;
      const runner = groupBy(runners, JSON.stringify(key), () => ({
        key,
        row,
        durationMs: 0,
        events: 0,
        unknownResourceEvents: 0,
      }));
      runner.durationMs += row.duration_ms;
      runner.events += row.events;
      if (
        row.runner_cpu_cores === null ||
        row.runner_memory_mb === null ||
        row.runner_disk_gb === null
      )
        runner.unknownResourceEvents += row.events;
    }

    if (row.kind !== "model") continue;
    groupBy(models, `${row.provider_id}\u0000${row.model_id}`, () => ({
      row,
      totals: new Totals(),
    })).totals.add(row);
    groupBy(threads, `${row.thread_id}\u0000${row.owner_user_id}`, () => ({
      row,
      totals: new Totals(),
    })).totals.add(row);

    if (row.price_source === "") continue;
    const priceKey = [
      row.provider_id,
      row.model_id,
      row.price_source,
      row.price_source_version,
      row.price_fresh_until,
    ] as const;
    const price = groupBy(prices, JSON.stringify(priceKey), () => ({
      key: priceKey,
      firstAt: row.first_at,
      lastAt: row.last_at,
      buckets: new Map(),
    }));
    price.firstAt = minText(price.firstAt, row.first_at);
    price.lastAt = maxText(price.lastAt, row.last_at);
    const bucket = price.buckets.get(row.bucket_from);
    if (bucket === undefined)
      price.buckets.set(row.bucket_from, [
        row.bucket_from,
        row.bucket_to,
        row.first_at,
        row.last_at,
      ]);
    else {
      bucket[2] = minText(bucket[2], row.first_at);
      bucket[3] = maxText(bucket[3], row.last_at);
    }
  }

  const dailyRows = [...days.entries()]
    .sort(([a], [b]) => compareText(a, b))
    .map(([day, { totals }]) => ({
      day,
      total_tokens: totals.totalTokens,
      unknown_token_events: totals.unknownTokenEvents,
      estimated_cost_micros: totals.estimatedCostMicros,
      unknown_cost_events: totals.unknownCostEvents,
      average_latency_ms: totals.averageLatencyMs,
      runner_duration_ms: totals.runnerDurationMs,
      model_turns: totals.modelTurns,
    }));

  const modelRows = [...models.values()]
    .map(({ row, totals }) => ({
      provider_id: row.provider_id,
      model_id: row.model_id,
      total_tokens: totals.totalTokens,
      unknown_token_events: totals.unknownTokenEvents,
      estimated_cost_micros: totals.estimatedCostMicros,
      unknown_cost_events: totals.unknownCostEvents,
      model_turns: totals.modelTurns,
    }))
    .sort(
      (a, b) =>
        b.estimated_cost_micros - a.estimated_cost_micros ||
        b.total_tokens - a.total_tokens ||
        compareText(a.provider_id, b.provider_id) ||
        compareText(a.model_id, b.model_id),
    )
    .slice(0, MODEL_BREAKDOWN_LIMIT);

  // The raw query groups runners in key order before it sorts them.
  const runnerRows = [...runners.values()]
    .sort((a, b) => {
      for (let index = 0; index < a.key.length; index += 1) {
        const order = compareValue(a.key[index] ?? null, b.key[index] ?? null);
        if (order !== 0) return order;
      }
      return 0;
    })
    .map((group) => ({
      provider: group.row.runner_provider,
      profile_id: group.row.runner_profile_id,
      profile_version: group.row.runner_profile_version,
      template: group.row.runner_template,
      cpu_cores: group.row.runner_cpu_cores,
      memory_mb: group.row.runner_memory_mb,
      disk_gb: group.row.runner_disk_gb,
      duration_ms: group.durationMs,
      events: group.events,
      unknown_resource_events: group.unknownResourceEvents,
    }))
    .sort(
      (a, b) =>
        b.duration_ms - a.duration_ms || compareValue(a.template, b.template),
    );

  const threadCandidates: Array<ThreadCandidate> = [...threads.values()]
    .map(
      ({ row, totals }): ThreadCandidate => [
        row.thread_id,
        row.owner_user_id,
        totals.totalTokens,
        totals.estimatedCostMicros,
        totals.unknownCostEvents,
        totals.modelTurns,
      ],
    )
    .sort((a, b) => b[3] - a[3] || b[2] - a[2] || compareText(b[0], a[0]));

  const priceProbes: Array<PriceProbe> = [...prices.values()].map(
    (group): PriceProbe => [
      ...group.key,
      group.firstAt,
      group.lastAt,
      [...group.buckets.values()] as ReadonlyArray<PriceProbeBucket>,
    ],
  );

  let peakDailyUsers = 0;
  for (const { users } of days.values())
    peakDailyUsers = Math.max(peakDailyUsers, users.size);

  return {
    summary: {
      input_tokens: summary.inputTokens,
      output_tokens: summary.outputTokens,
      cache_read_tokens: summary.cacheReadTokens,
      cache_write_tokens: summary.cacheWriteTokens,
      reasoning_tokens:
        summary.reasoningEvents > 0 ? summary.reasoningTokens : null,
      total_tokens: summary.totalTokens,
      unknown_token_events: summary.unknownTokenEvents,
      estimated_cost_micros: summary.estimatedCostMicros,
      known_cost_events: summary.knownCostEvents,
      unknown_cost_events: summary.unknownCostEvents,
      model_turns: summary.modelTurns,
      average_latency_ms: summary.averageLatencyMs,
      tool_duration_ms: summary.toolDurationMs,
      runner_duration_ms: summary.runnerDurationMs,
      success_outcomes: summary.success,
      error_outcomes: summary.error,
      cancelled_outcomes: summary.cancelled,
      unknown_outcomes: summary.unknown,
    },
    daily: dailyRows,
    peakDailyUsers,
    models: modelRows,
    runners: runnerRows,
    rankings: [...rankings.values()],
    threadCandidates,
    priceProbes,
  };
};

export type WorkspaceUsageAggregates = ReturnType<
  typeof aggregateWorkspaceUsage
>;

interface Cursor {
  readonly estimatedCostMicros: number;
  readonly id: string;
}

const afterCursor = (cost: number, id: string, cursor: Cursor | undefined) =>
  cursor === undefined ||
  cost < cursor.estimatedCostMicros ||
  (cost === cursor.estimatedCostMicros && compareText(id, cursor.id) < 0);

/**
 * The users ranking page: members who still have a user row, after the
 * cursor, most expensive first, `limit` rows (the caller asks one extra).
 */
export const rankUsers = (
  groups: ReadonlyArray<RankingGroup>,
  userNames: ReadonlyMap<string, string>,
  cursor: Cursor | undefined,
  limit: number,
) =>
  groups
    .flatMap((group) => {
      const userName = userNames.get(group.ownerUserId);
      return userName === undefined
        ? []
        : [
            {
              user_id: group.ownerUserId,
              user_name: userName,
              ...rankingRow(group),
            },
          ];
    })
    .filter((row) =>
      afterCursor(row.estimated_cost_micros, row.user_id, cursor),
    )
    .sort(
      (a, b) =>
        b.estimated_cost_micros - a.estimated_cost_micros ||
        compareText(b.user_id, a.user_id),
    )
    .slice(0, limit);

/** The Projects ranking page, as `rankUsers`, per Project and owner. */
export const rankProjects = (
  groups: ReadonlyArray<RankingGroup>,
  projectNames: ReadonlyMap<string, string>,
  userNames: ReadonlyMap<string, string>,
  cursor: Cursor | undefined,
  limit: number,
) =>
  groups
    .flatMap((group) => {
      const projectName = projectNames.get(group.projectId);
      const ownerName = userNames.get(group.ownerUserId);
      return projectName === undefined || ownerName === undefined
        ? []
        : [
            {
              project_id: group.projectId,
              project_name: projectName,
              owner_user_id: group.ownerUserId,
              owner_name: ownerName,
              ...rankingRow(group),
            },
          ];
    })
    .filter((row) =>
      afterCursor(row.estimated_cost_micros, row.project_id, cursor),
    )
    .sort(
      (a, b) =>
        b.estimated_cost_micros - a.estimated_cost_micros ||
        compareText(b.project_id, a.project_id) ||
        compareText(a.owner_user_id, b.owner_user_id),
    )
    .slice(0, limit);
