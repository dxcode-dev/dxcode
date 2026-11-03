import { env } from "cloudflare:test";
import {
  ModelUsageEventInput,
  normalizeUsageQuery,
  RunnerUsageEventInput,
  SubmissionUsageEventInput,
  ToolUsageEventInput,
  type UsageEventInputType,
  UsagePriceMetadata,
  type UsagePriceMetadataType,
  UsageQuery,
  UsageRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageRepositoryD1 } from "../../src/settings/usage/repository-d1.js";
import { purgeExpiredUsageEvents } from "../../src/settings/usage/retention.js";
import { backfillUsageRollups } from "../../src/settings/usage/rollup-d1.js";

// The usage page reads hourly and daily rollups (migration 0125). Every
// dashboard here is compared with the same dashboard read from raw events,
// which is what the page returned before the rollups: the two must match
// byte for byte across time zones, ranges, filters, pages, late and
// duplicate events, retention, and the backfill of events stored before the
// migration.

const owner = Schema.decodeUnknownSync(UserId)("rollup-owner");
const otherOwner = Schema.decodeUnknownSync(UserId)("rollup-other");
const projectA = "prj_00000000-0000-4000-8000-000000001231";
const projectB = "prj_00000000-0000-4000-8000-000000001232";
const otherProject = "prj_00000000-0000-4000-8000-000000001233";
const threads = [
  "thr_00000000-0000-4000-8000-000000001231",
  "thr_00000000-0000-4000-8000-000000001232",
  "thr_00000000-0000-4000-8000-000000001233",
  "thr_00000000-0000-4000-8000-000000001234",
] as const;
const otherThread = "thr_00000000-0000-4000-8000-000000001235";

const RETENTION_MS = 180 * 86_400_000;
const START = Date.parse("2026-08-01T00:00:00.000Z");

const runUsage = <A, E>(effect: Effect.Effect<A, E, UsageRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageRepositoryD1(env.DB))));

const price = (
  sourceVersion: string,
  effectiveFrom: string,
  effectiveTo: string | null,
  overrides: Partial<Record<string, unknown>> = {},
) =>
  Schema.decodeUnknownSync(UsagePriceMetadata)({
    providerId: "openai",
    modelId: "gpt-5.2",
    currency: "USD",
    source: "deployment",
    sourceVersion,
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 8_000_000,
    cacheReadMicrosPerMillion: 200_000,
    cacheWriteMicrosPerMillion: 2_500_000,
    effectiveFrom,
    effectiveTo,
    freshUntil: "2026-09-01T00:00:00.000Z",
    estimated: true,
    ...overrides,
  });

// One price version whose first window ends, and second starts, mid-hour:
// events of 2026-08-05 10:00 match two different usage_price rows.
const pricing = {
  early: price(
    "pricing-a",
    "2026-07-01T00:00:00.000Z",
    "2026-08-05T10:20:00.000Z",
  ),
  late: price("pricing-a", "2026-08-05T10:20:00.000Z", null),
  // Starts exactly on an hour: no split.
  onHour: price("pricing-c", "2026-08-07T00:00:00.000Z", null, {
    inputMicrosPerMillion: 3_000_000,
  }),
  catalog: price("catalog-1", "2026-07-15T00:00:00.000Z", null, {
    source: "catalog",
    modelId: "gpt-5.2-mini",
  }),
};

/** A deterministic generator, so a failure replays. */
const random = (() => {
  let state = 1489;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
})();
const pick = <T>(values: ReadonlyArray<T>): T =>
  values[Math.floor(random() * values.length)] as T;

const eventAt = (index: number, at: number): UsageEventInputType => {
  const threadId = pick(threads);
  const occurredAt = new Date(at).toISOString();
  const base = {
    id: `rollup-${index}`,
    threadId,
    occurredAt,
    outcome: pick([
      "success",
      "success",
      "success",
      "error",
      "cancelled",
      "unknown",
    ]),
  };
  const kind = pick([
    "model",
    "model",
    "model",
    "model",
    "tool",
    "submission",
    "runner",
  ]);
  if (kind === "tool")
    return Schema.decodeUnknownSync(ToolUsageEventInput)({
      ...base,
      kind,
      durationMs: random() < 0.2 ? null : Math.floor(random() * 5_000),
      submissionId: null,
      toolCallId: `call-${index}`,
      toolName: "bash",
      toolOrigin: "model",
      runtime: "flue",
    });
  if (kind === "submission")
    return Schema.decodeUnknownSync(SubmissionUsageEventInput)({
      ...base,
      kind,
      durationMs: null,
      submissionId: `sub-${index}`,
    });
  if (kind === "runner")
    return Schema.decodeUnknownSync(RunnerUsageEventInput)({
      ...base,
      kind,
      durationMs: Math.floor(random() * 90_000),
      provider: "e2b",
      decision: pick(["create", "connect"]),
      runnerId: `sandbox-${index}`,
      template: pick(["dx-workspace", "dx-large"]),
      activeTimeoutMs: 600_000,
      resources: pick([
        {
          profileId: null,
          profileVersion: null,
          cpuCores: 4,
          memoryMb: 8192,
          diskGb: null,
        },
        {
          profileId: "",
          profileVersion: 0,
          cpuCores: 0.5,
          memoryMb: 512,
          diskGb: 10,
        },
        {
          profileId: "large",
          profileVersion: 3,
          cpuCores: 8,
          memoryMb: 16_384,
          diskGb: 40,
        },
      ]),
    });
  const identity = pick([
    ["openai", "OpenAI", "gpt-5.2"],
    ["openai", "OpenAI", "gpt-5.2-mini"],
    ["anthropic", "Anthropic", "claude-x"],
  ] as const);
  const tokens = random() < 0.15;
  const input = Math.floor(random() * 200_000);
  const output = Math.floor(random() * 20_000);
  return Schema.decodeUnknownSync(ModelUsageEventInput)({
    ...base,
    kind,
    durationMs: random() < 0.1 ? null : Math.floor(random() * 30_000),
    submissionId: `sub-${index}`,
    turnId: `turn-${index}`,
    purpose: "agent",
    observedProviderId: identity[0],
    observedProviderName: identity[1],
    observedModelId: identity[2],
    ...(random() < 0.2
      ? {
          routeAttribution: {
            connectionId: "conn-route",
            providerId: identity[0],
            modelId: identity[2],
          },
        }
      : {}),
    inputTokens: tokens ? null : input,
    outputTokens: tokens ? null : output,
    cacheReadTokens: tokens ? null : Math.floor(random() * 50_000),
    cacheWriteTokens: tokens ? null : 0,
    reasoningTokens: random() < 0.7 ? null : Math.floor(random() * 4_000),
    totalTokens: tokens ? null : input + output,
  });
};

const priceFor = (
  event: UsageEventInputType,
): UsagePriceMetadataType | undefined => {
  if (event.kind !== "model" || event.observedProviderId !== "openai")
    return undefined;
  if (event.observedModelId === "gpt-5.2-mini") return pricing.catalog;
  const at = Date.parse(
    Schema.encodeSync(Schema.DateTimeUtcFromString)(event.occurredAt),
  );
  if (at >= Date.parse("2026-08-07T00:00:00.000Z") && random() < 0.5)
    return pricing.onHour;
  // Some events record a window that no longer covers them: stale.
  if (random() < 0.1) return pricing.early;
  return at < Date.parse("2026-08-05T10:20:00.000Z")
    ? pricing.early
    : pricing.late;
};

const record = (events: ReadonlyArray<UsageEventInputType>) =>
  runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      for (const event of events)
        yield* repository.record(event, priceFor(event));
    }),
  );

/** Times that sit on the edges the rollups split at. */
const edgeTimes = [
  "2026-08-01T00:00:00.000Z",
  "2026-08-01T18:29:59.999Z",
  "2026-08-01T18:30:00.000Z",
  "2026-08-02T03:44:59.999Z",
  "2026-08-02T03:45:00.000Z",
  "2026-08-03T18:14:59.999Z",
  "2026-08-03T18:15:00.000Z",
  "2026-08-04T23:59:59.999Z",
  "2026-08-05T10:19:59.999Z",
  "2026-08-05T10:20:00.000Z",
  "2026-08-05T10:59:59.999Z",
  "2026-08-06T23:53:00.000Z",
  "2026-08-07T00:00:00.000Z",
  "2026-08-09T08:00:00.000Z",
  "2026-08-11T23:59:59.999Z",
].map(Date.parse);

const dataset = (count: number, offset: number) => {
  const times = [
    ...edgeTimes,
    ...Array.from(
      { length: count },
      () => START + Math.floor(random() * 12 * 86_400_000),
    ),
  ];
  // Out of order: the rollups must not depend on arrival order.
  return times
    .map((at, index) => ({ at, key: random(), index: index + offset }))
    .sort((a, b) => a.key - b.key)
    .map(({ at, index }) => eventAt(index, at));
};

const dashboard = async (overrides: Record<string, unknown>) => {
  const decoded = Schema.decodeUnknownSync(UsageQuery)(overrides);
  const normalized = await Effect.runPromise(normalizeUsageQuery(decoded));
  return runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return yield* repository.dashboard(owner, normalized);
    }),
  );
};

const setBackfill = (through: number, end: number) =>
  env.DB.prepare(
    "UPDATE usage_rollup_backfill SET through_rowid = ?, end_rowid = ? WHERE singleton = 1",
  )
    .bind(through, end)
    .run();

/**
 * The dashboard read from raw events. A backfill still running sends the
 * page to raw events; this one ends in the read itself, leaving the rollup
 * path for the next read.
 */
const rawDashboard = async (overrides: Record<string, unknown>) => {
  await setBackfill(-1, 0);
  const result = await dashboard(overrides);
  const state = await env.DB.prepare(
    "SELECT through_rowid, end_rowid FROM usage_rollup_backfill",
  ).first();
  expect(state).toEqual({ through_rowid: 0, end_rowid: 0 });
  return result;
};

const ranges = [
  { from: "2026-08-01", to: "2026-08-12" },
  { from: "2026-08-05", to: "2026-08-05" },
  { from: "2026-08-03", to: "2026-08-04" },
];
const offsets = [0, 330, -225, 345, -480, 840, -720, 7];
const filters = [
  {},
  { providerId: "openai" },
  { modelId: "gpt-5.2" },
  { providerId: "openai", modelId: "gpt-5.2-mini" },
];

/** Every query of the matrix, with each page of its Threads. */
const expectRollupsMatchRaw = async () => {
  let compared = 0;
  for (const range of ranges)
    for (const timezoneOffsetMinutes of offsets)
      for (const filter of filters) {
        const query = { ...range, timezoneOffsetMinutes, ...filter };
        const raw = await rawDashboard(query);
        const rolled = await dashboard(query);
        expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
        compared += 1;
      }
  // Keyset pages of two Threads.
  for (const timezoneOffsetMinutes of [0, 330]) {
    let cursor: string | undefined;
    do {
      const query = {
        from: "2026-08-01",
        to: "2026-08-12",
        timezoneOffsetMinutes,
        limit: 2,
        ...(cursor === undefined ? {} : { cursor }),
      };
      const raw = await rawDashboard(query);
      const rolled = await dashboard(query);
      expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
      cursor = raw.nextCursor;
      compared += 1;
    } while (cursor !== undefined);
  }
  return compared;
};

const rollupRows = async () => {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM usage_hourly) AS hourly,
            (SELECT COUNT(*) FROM usage_thread_daily) AS daily,
            (SELECT COALESCE(SUM(events), 0) FROM usage_hourly) AS hourly_events,
            (SELECT COALESCE(SUM(events), 0) FROM usage_thread_daily) AS daily_events,
            (SELECT COUNT(*) FROM usage_event) AS events`,
  ).first<{
    hourly: number;
    daily: number;
    hourly_events: number;
    daily_events: number;
    events: number;
  }>();
  if (row === null) throw new Error("Missing rollup counts.");
  return row;
};

const reset = () =>
  env.DB.batch([
    env.DB.prepare(
      "UPDATE usage_rollup_backfill SET through_rowid = 0, end_rowid = 0",
    ),
    env.DB.prepare("DELETE FROM usage_event"),
    env.DB.prepare("DELETE FROM usage_hourly"),
    env.DB.prepare("DELETE FROM usage_thread_daily"),
  ]);

beforeEach(async () => {
  await reset();
  await env.DB.batch([
    ...[
      [projectA, owner, "Rollup A"],
      [projectB, owner, "Rollup B"],
      [otherProject, otherOwner, "Other"],
    ].map(([id, ownedBy, name]) =>
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(
        id,
        ownedBy,
        name,
        "2026-07-01T00:00:00.000Z",
        "2026-07-01T00:00:00.000Z",
      ),
    ),
    ...[
      [threads[0], projectA, owner, { kind: "model", model: "openai/gpt-5.2" }],
      [threads[1], projectA, owner, { kind: "mode", mode: "deep" }],
      [threads[2], projectB, owner, { kind: "model", model: "openai/gpt-5.2" }],
      [threads[3], projectB, owner, { kind: "mode", mode: "fast" }],
      [otherThread, otherProject, otherOwner, { kind: "mode", mode: "medium" }],
    ].map(([id, project, ownedBy, selection]) =>
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at, model_selection) VALUES (?, ?, ?, ?, ?, ?)",
      ).bind(
        id,
        project,
        ownedBy,
        "2026-07-20T00:00:00.000Z",
        "2026-07-20T00:00:00.000Z",
        JSON.stringify(selection),
      ),
    ),
  ]);
});

afterEach(reset);

describe("usage rollups", () => {
  it("answer every dashboard exactly as raw events do, through late, duplicate, and expired events", async () => {
    await record(dataset(500, 0));
    // Another owner's usage in the same hours stays out.
    await record(
      [0, 1, 2].map((index) =>
        Schema.decodeUnknownSync(SubmissionUsageEventInput)({
          id: `rollup-other-${index}`,
          kind: "submission",
          threadId: otherThread,
          occurredAt: new Date(START + index * 3_600_000).toISOString(),
          outcome: "success",
          durationMs: null,
          submissionId: `other-${index}`,
        }),
      ),
    );
    // Replayed observations are ignored once, by the event table and the
    // rollups alike.
    await record(dataset(40, 0).slice(0, 40));
    let rows = await rollupRows();
    expect(rows.hourly_events).toBe(rows.events);
    expect(rows.daily_events).toBe(rows.events);
    expect(rows.hourly).toBeLessThan(rows.events);
    expect(await expectRollupsMatchRaw()).toBeGreaterThan(90);

    // An event arriving late lands in its own past hour.
    await record(dataset(30, 10_000));
    await expectRollupsMatchRaw();

    // Retention deletes events up to a time inside an hour.
    const purge = await purgeExpiredUsageEvents(
      env.DB,
      new Date(
        Date.parse("2026-08-04T12:34:56.789Z") + RETENTION_MS,
      ).toISOString(),
    );
    expect(purge.meta.changes).toBeGreaterThan(0);
    rows = await rollupRows();
    expect(rows.hourly_events).toBe(rows.events);
    expect(rows.daily_events).toBe(rows.events);
    await expectRollupsMatchRaw();
  }, 60_000);

  it("picks each event's price in an hour a price window starts inside", async () => {
    const model = (id: string, occurredAt: string) =>
      Schema.decodeUnknownSync(ModelUsageEventInput)({
        id,
        kind: "model",
        threadId: threads[0],
        occurredAt,
        outcome: "success",
        durationMs: 900,
        submissionId: id,
        turnId: id,
        purpose: "agent",
        observedProviderId: "openai",
        observedProviderName: "OpenAI",
        observedModelId: "gpt-5.2",
        inputTokens: 1_000,
        outputTokens: 10,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        reasoningTokens: null,
        totalTokens: 1_010,
      });
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        // Only the later window has an event, and only after 10:20 in the
        // hour the windows meet.
        yield* repository.record(
          model("split-late", "2026-08-05T10:40:00.000Z"),
          pricing.late,
        );
        yield* repository.putPrice(pricing.early);
      }),
    );
    const query = {
      from: "2026-08-05",
      to: "2026-08-05",
      timezoneOffsetMinutes: 0,
    };
    const raw = await rawDashboard(query);
    const rolled = await dashboard(query);
    expect(raw.priceSources.map(({ effectiveFrom }) => effectiveFrom)).toEqual([
      pricing.late.effectiveFrom,
    ]);
    expect(raw.summary.tokens.reasoning).toBeNull();
    expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
  });

  it("serves raw events until the backfill of older events finishes, then matches them exactly", async () => {
    await record(dataset(300, 20_000));
    const before = await rawDashboard({
      from: "2026-08-01",
      to: "2026-08-12",
      timezoneOffsetMinutes: 330,
    });
    // As migration 0125 leaves a database with events: rollups empty, every
    // stored event waiting for the backfill.
    const last = await env.DB.prepare(
      "SELECT MAX(rowid) AS last FROM usage_event",
    ).first<{ last: number }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_hourly"),
      env.DB.prepare("DELETE FROM usage_thread_daily"),
    ]);
    await setBackfill(0, last?.last ?? 0);

    // Chunks interleave with new events and retention deletes, before and
    // after the backfill reaches them.
    let done = false;
    let round = 0;
    while (!done) {
      done = await backfillUsageRollups(env.DB, 1, 41);
      if (round === 1) await record(dataset(25, 30_000));
      if (round === 2)
        await purgeExpiredUsageEvents(
          env.DB,
          new Date(
            Date.parse("2026-08-02T06:00:00.000Z") + RETENTION_MS,
          ).toISOString(),
        );
      if (round === 3) {
        // While the backfill runs, the page reads raw events.
        const during = await dashboard({
          from: "2026-08-01",
          to: "2026-08-12",
          timezoneOffsetMinutes: 330,
        });
        expect(during.summary.modelTurns).toBeGreaterThan(0);
      }
      round += 1;
    }
    expect(round).toBeGreaterThan(4);
    const rows = await rollupRows();
    expect(rows.hourly_events).toBe(rows.events);
    expect(rows.daily_events).toBe(rows.events);
    expect(before.summary.modelTurns).toBeGreaterThan(0);
    await expectRollupsMatchRaw();
  }, 60_000);

  it("adds a backfill chunk once when two runs race for it", async () => {
    await record(dataset(60, 40_000));
    const last = await env.DB.prepare(
      "SELECT MAX(rowid) AS last FROM usage_event",
    ).first<{ last: number }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_hourly"),
      env.DB.prepare("DELETE FROM usage_thread_daily"),
    ]);
    await setBackfill(0, last?.last ?? 0);
    await Promise.all([
      backfillUsageRollups(env.DB, 10, 7),
      backfillUsageRollups(env.DB, 10, 7),
      backfillUsageRollups(env.DB, 10, 7),
    ]);
    while (!(await backfillUsageRollups(env.DB, 10, 7))) {}
    const rows = await rollupRows();
    expect(rows.hourly_events).toBe(rows.events);
    expect(rows.daily_events).toBe(rows.events);
    await expectRollupsMatchRaw();
  }, 60_000);
});
