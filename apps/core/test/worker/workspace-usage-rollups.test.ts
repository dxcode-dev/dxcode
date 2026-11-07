import { env } from "cloudflare:test";
import {
  ModelUsageEventInput,
  normalizeWorkspaceUsageQuery,
  RunnerUsageEventInput,
  SubmissionUsageEventInput,
  ToolUsageEventInput,
  type UsageEventInputType,
  UsagePriceMetadata,
  type UsagePriceMetadataType,
  UsageRepository,
  type WorkspaceId,
  WorkspaceUsageQuery,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UsageRepositoryD1 } from "../../src/settings/usage/repository-d1.js";
import { purgeExpiredUsageEvents } from "../../src/settings/usage/retention.js";
import { backfillWorkspaceUsageRollups } from "../../src/settings/usage/workspace-rollup-d1.js";

// The workspace usage page reads per-workspace rollups (migration 0151, #1933)
// instead of every raw usage_event of the workspace about ten times over. Every
// dashboard here is compared with the same dashboard read from raw events,
// which is what the page returned before: the two must match byte for byte
// across time zones, ranges, filters, rankings, pages, shared and private
// Threads, late and duplicate events, retention, and the backfill of events
// stored before the migration. A load must also stay inside a fixed D1 rows
// budget: the page once read 0.5-0.9M rows per query and overloaded D1 for
// the whole app.

const workspaceId = "rollup-workspace" as WorkspaceId;
const foreignWorkspaceId = "rollup-workspace-foreign";
const members = ["ws-m0", "ws-m1", "ws-m2", "ws-m3"] as const;
const foreigner = "ws-foreign";
const loner = "ws-loner";
const project = (index: number) =>
  `prj_00000000-0000-4000-8000-0000000019${String(index).padStart(2, "0")}`;
const thread = (index: number) =>
  `thr_00000000-0000-4000-8000-0000000019${String(index).padStart(2, "0")}`;

/** Each member owns one Project with two Threads, shared in several ways. */
const threads = [
  // [index, project, owner, visibility, access, shared with, state]
  [0, 0, members[0], "workspace", "view", workspaceId, "active"],
  [1, 0, members[0], "private", "none", null, "active"],
  [2, 1, members[1], "workspace", "view", workspaceId, "active"],
  [3, 1, members[1], "workspace", "view", foreignWorkspaceId, "active"],
  [4, 2, members[2], "workspace", "view", workspaceId, "deleted"],
  [5, 2, members[2], "workspace", "view", workspaceId, "active"],
  [6, 3, members[3], "private", "none", null, "active"],
  [7, 3, members[3], "workspace", "view", workspaceId, "active"],
  [8, 4, foreigner, "private", "none", null, "active"],
  [9, 5, loner, "private", "none", null, "active"],
] as const;

const RETENTION_MS = 180 * 86_400_000;
const START = Date.parse("2026-08-01T00:00:00.000Z");

const runUsage = <A, E>(
  effect: Effect.Effect<A, E, UsageRepository>,
  db: D1Database = env.DB,
) => Effect.runPromise(effect.pipe(Effect.provide(UsageRepositoryD1(db))));

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

// One price version whose first window ends, and second starts, mid-day and
// mid-hour: events of 2026-08-05 match two different usage_price rows.
const pricing = {
  early: price(
    "pricing-a",
    "2026-07-01T00:00:00.000Z",
    "2026-08-05T10:20:00.000Z",
  ),
  late: price("pricing-a", "2026-08-05T10:20:00.000Z", null),
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
  let state = 1933;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
})();
const pick = <T>(values: ReadonlyArray<T>): T =>
  values[Math.floor(random() * values.length)] as T;

const eventAt = (
  index: number,
  at: number,
  threadIds: ReadonlyArray<string>,
): UsageEventInputType => {
  const threadId = pick(threadIds);
  const occurredAt = new Date(at).toISOString();
  const base = {
    id: `ws-rollup-${index}`,
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

const allThreads = threads.map(([index]) => thread(index));

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
    .map(({ at, index }) => eventAt(index, at, allThreads));
};

const dashboard = async (
  overrides: Record<string, unknown>,
  db: D1Database = env.DB,
) => {
  const decoded = Schema.decodeUnknownSync(WorkspaceUsageQuery)(overrides);
  const normalized = await Effect.runPromise(
    normalizeWorkspaceUsageQuery(decoded),
  );
  return runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return yield* repository.workspaceDashboard(workspaceId, normalized);
    }),
    db,
  );
};

const setBackfill = (through: number, end: number) =>
  env.DB.prepare(
    "UPDATE usage_workspace_rollup_backfill SET through_rowid = ?, end_rowid = ? WHERE singleton = 1",
  )
    .bind(through, end)
    .run();

/**
 * The dashboard read from raw events. A backfill still running sends the
 * page to raw events; this one ends in the read itself, leaving the rollup
 * path for the next read.
 */
const rawDashboard = async (
  overrides: Record<string, unknown>,
  db: D1Database = env.DB,
) => {
  await setBackfill(-1, 0);
  const result = await dashboard(overrides, db);
  const state = await env.DB.prepare(
    "SELECT through_rowid, end_rowid FROM usage_workspace_rollup_backfill",
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
  { userId: members[1] },
  { projectId: project(0) },
  { providerId: "openai" },
  { modelId: "gpt-5.2" },
  { providerId: "openai", modelId: "gpt-5.2-mini" },
];

/** Every query of the matrix, in both rankings, with each ranking page. */
const expectRollupsMatchRaw = async () => {
  let compared = 0;
  for (const range of ranges)
    for (const timezoneOffsetMinutes of offsets)
      for (const filter of filters)
        for (const ranking of ["users", "projects"]) {
          if (ranking === "projects" && timezoneOffsetMinutes % 120 !== 0)
            continue;
          const query = { ...range, timezoneOffsetMinutes, ranking, ...filter };
          const raw = await rawDashboard(query);
          const rolled = await dashboard(query);
          expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
          compared += 1;
        }
  for (const ranking of ["users", "projects"] as const)
    for (const timezoneOffsetMinutes of [0, 330]) {
      let cursor: string | undefined;
      do {
        const query = {
          from: "2026-08-01",
          to: "2026-08-12",
          timezoneOffsetMinutes,
          ranking,
          limit: 1,
          ...(cursor === undefined ? {} : { cursor }),
        };
        const raw = await rawDashboard(query);
        const rolled = await dashboard(query);
        expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
        cursor = raw.ranking.nextCursor;
        compared += 1;
      } while (cursor !== undefined);
    }
  return compared;
};

const rollupRows = async () => {
  const row = await env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM usage_workspace_daily) AS daily,
            (SELECT COUNT(*) FROM usage_workspace_hourly) AS hourly,
            (SELECT COALESCE(SUM(events), 0) FROM usage_workspace_daily) AS daily_events,
            (SELECT COALESCE(SUM(events), 0) FROM usage_workspace_hourly) AS hourly_events,
            (SELECT COUNT(*) FROM usage_event WHERE workspace_id IS NOT NULL) AS events`,
  ).first<{
    daily: number;
    hourly: number;
    daily_events: number;
    hourly_events: number;
    events: number;
  }>();
  if (row === null) throw new Error("Missing rollup counts.");
  return row;
};

const expectRollupsHoldEveryEvent = async () => {
  const rows = await rollupRows();
  expect(rows.daily_events).toBe(rows.events);
  expect(rows.hourly_events).toBe(rows.events);
  return rows;
};

/** Every D1 row a binding's queries read, as D1 reports it per statement. */
const countRowsRead = (database: D1Database) => {
  let rowsRead = 0;
  const real = new WeakMap<object, D1PreparedStatement>();
  const add = (result: { meta?: { rows_read?: number } }) => {
    rowsRead += result.meta?.rows_read ?? 0;
  };
  const statement = (inner: D1PreparedStatement): D1PreparedStatement => {
    const wrapped = new Proxy(inner, {
      get(target, property) {
        if (property === "bind")
          return (...values: unknown[]) => statement(target.bind(...values));
        if (property === "all" || property === "run")
          return async () => {
            const result = await target[property]();
            add(result);
            return result;
          };
        if (property === "first")
          return async (column?: string) => {
            const result = await target.all<Record<string, unknown>>();
            add(result);
            const row = result.results[0] ?? null;
            return column === undefined ? row : (row?.[column] ?? null);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    real.set(wrapped, inner);
    return wrapped;
  };
  const db = new Proxy(database, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => statement(target.prepare(sql));
      if (property === "batch")
        return async (statements: D1PreparedStatement[]) => {
          const results = await target.batch(
            statements.map((item) => real.get(item) ?? item),
          );
          for (const result of results) add(result);
          return results;
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    db,
    take: () => {
      const read = rowsRead;
      rowsRead = 0;
      return read;
    },
  };
};

const reset = () =>
  env.DB.batch([
    env.DB.prepare(
      "UPDATE usage_workspace_rollup_backfill SET through_rowid = 0, end_rowid = 0",
    ),
    env.DB.prepare(
      "UPDATE usage_rollup_backfill SET through_rowid = 0, end_rowid = 0",
    ),
    env.DB.prepare("DELETE FROM usage_event"),
    env.DB.prepare("DELETE FROM usage_price"),
    env.DB.prepare("DELETE FROM usage_hourly"),
    env.DB.prepare("DELETE FROM usage_thread_daily"),
    env.DB.prepare("DELETE FROM usage_workspace_daily"),
    env.DB.prepare("DELETE FROM usage_workspace_hourly"),
  ]);

const createdAt = "2026-07-20T00:00:00.000Z";

const seedPeople = (extraMembers: ReadonlyArray<string> = []) =>
  env.DB.batch([
    ...[
      [workspaceId, "Rollup Team", "rollup-team"],
      [foreignWorkspaceId, "Foreign Team", "rollup-foreign"],
    ].map(([id, name, slug]) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
      ).bind(id, name, slug),
    ),
    ...[...members, ...extraMembers, foreigner, loner].map((id) =>
      env.DB.prepare(
        'INSERT OR IGNORE INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
      ).bind(id, `Name ${id}`, `${id}@example.com`),
    ),
    // Signing up creates the personal account; a display name overrides the
    // user's name everywhere usage names a member.
    env.DB.prepare(
      "UPDATE personal_account SET display_name = 'Shown Name' WHERE user_id = ?",
    ).bind(members[0]),
    ...[...members, ...extraMembers].map((userId, index) =>
      env.DB.prepare(
        "INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', ?)",
      ).bind(`member-${userId}`, workspaceId, userId, index + 1),
    ),
    env.DB.prepare(
      "INSERT OR IGNORE INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', 1)",
    ).bind("member-foreigner", foreignWorkspaceId, foreigner),
  ]);

const seedThreads = (
  rows: ReadonlyArray<
    readonly [
      threadId: string,
      projectId: string,
      owner: string,
      visibility: string,
      access: string,
      sharedWith: string | null,
      state: string,
    ]
  >,
) =>
  env.DB.batch([
    ...[...new Map(rows.map((row) => [row[1], row[2]])).entries()].map(
      ([projectId, owner]) =>
        env.DB.prepare(
          "INSERT OR IGNORE INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
        ).bind(
          projectId,
          owner,
          `Project ${projectId.slice(-4)}`,
          createdAt,
          createdAt,
        ),
    ),
    ...rows.map(
      ([id, projectId, owner, visibility, access, sharedWith, state]) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO threads (id, project_id, owner_user_id, title, created_at, updated_at,
           visibility, workspace_access, shared_workspace_id, lifecycle_state)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          id,
          projectId,
          owner,
          `Thread ${id.slice(-4)}`,
          createdAt,
          createdAt,
          visibility,
          access,
          sharedWith,
          state,
        ),
    ),
  ]);

beforeEach(reset);
afterEach(reset);

describe("workspace usage rollups", () => {
  it("answer every workspace dashboard exactly as raw events do, through late, duplicate, and expired events", async () => {
    await seedPeople();
    await seedThreads(
      threads.map(
        ([
          index,
          projectIndex,
          owner,
          visibility,
          access,
          sharedWith,
          state,
        ]) => [
          thread(index),
          project(projectIndex),
          owner,
          visibility,
          access,
          sharedWith,
          state,
        ],
      ),
    );
    await record(dataset(500, 0));
    // Replayed observations are ignored once, by the event table and the
    // rollups alike.
    await record(dataset(40, 0).slice(0, 40));
    const rows = await expectRollupsHoldEveryEvent();
    expect(rows.daily).toBeLessThan(rows.events);
    // The foreign member's and the member of no workspace's events stay out.
    expect(
      await env.DB.prepare(
        "SELECT COUNT(DISTINCT workspace_id) AS workspaces FROM usage_workspace_hourly",
      ).first("workspaces"),
    ).toBe(2);
    expect(await expectRollupsMatchRaw()).toBeGreaterThan(200);

    // An event arriving late lands in its own past day and hour.
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
    await expectRollupsHoldEveryEvent();
    await expectRollupsMatchRaw();
  }, 300_000);

  it("serves raw events until the backfill of older events finishes, then matches them exactly", async () => {
    await seedPeople();
    await seedThreads(
      threads.map(
        ([
          index,
          projectIndex,
          owner,
          visibility,
          access,
          sharedWith,
          state,
        ]) => [
          thread(index),
          project(projectIndex),
          owner,
          visibility,
          access,
          sharedWith,
          state,
        ],
      ),
    );
    await record(dataset(300, 20_000));
    // As migration 0151 leaves a database with events: rollups empty, every
    // stored event waiting for the backfill.
    const last = await env.DB.prepare(
      "SELECT MAX(rowid) AS last FROM usage_event",
    ).first<{ last: number }>();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_workspace_daily"),
      env.DB.prepare("DELETE FROM usage_workspace_hourly"),
    ]);
    await setBackfill(0, last?.last ?? 0);

    // Chunks interleave with new events and retention deletes, before and
    // after the backfill reaches them, and with runs racing for a chunk.
    let done = false;
    let round = 0;
    while (!done) {
      const [first] = await Promise.all([
        backfillWorkspaceUsageRollups(env.DB, 1, 41),
        backfillWorkspaceUsageRollups(env.DB, 1, 41),
      ]);
      done = first;
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
    expect(round).toBeGreaterThan(3);
    await expectRollupsHoldEveryEvent();
    await expectRollupsMatchRaw();
  }, 300_000);

  it("keeps a 30-day load of ten members' usage inside 20,000 D1 rows, where raw events read far more", async () => {
    // Ten members, each with three Threads, working eight hours a day for a
    // month: about 9,000 events.
    const team = Array.from({ length: 6 }, (_, index) => `ws-budget-${index}`);
    await seedPeople(team);
    const people = [...members, ...team];
    const budgetThreads = people.flatMap((owner, memberIndex) =>
      [0, 1, 2].map(
        (slot) =>
          [
            thread(20 + memberIndex * 3 + slot),
            project(20 + memberIndex),
            owner,
            slot === 0 ? "workspace" : "private",
            slot === 0 ? "view" : "none",
            slot === 0 ? workspaceId : null,
            "active",
          ] as const,
      ),
    );
    await seedThreads(budgetThreads);
    const events: Array<UsageEventInputType> = [];
    for (let day = 0; day < 30; day += 1)
      for (const [memberIndex] of people.entries()) {
        const threadIds = budgetThreads
          .slice(memberIndex * 3, memberIndex * 3 + 3)
          .map(([id]) => id);
        for (let turn = 0; turn < 30; turn += 1)
          events.push(
            eventAt(
              events.length + 50_000,
              START +
                day * 86_400_000 +
                (9 + Math.floor(random() * 8)) * 3_600_000 +
                Math.floor(random() * 3_600_000),
              threadIds,
            ),
          );
      }
    await record(events);
    await expectRollupsHoldEveryEvent();

    const counter = countRowsRead(env.DB);
    for (const query of [
      { from: "2026-08-01", to: "2026-08-30", timezoneOffsetMinutes: 0 },
      { from: "2026-08-24", to: "2026-08-30", timezoneOffsetMinutes: 0 },
      {
        from: "2026-08-01",
        to: "2026-08-30",
        timezoneOffsetMinutes: 0,
        ranking: "projects",
      },
    ]) {
      const rolled = await dashboard(query, counter.db);
      const rolledRows = counter.take();
      expect(rolledRows).toBeLessThan(20_000);
      const raw = await rawDashboard(query, counter.db);
      const rawRows = counter.take();
      expect(JSON.stringify(rolled)).toBe(JSON.stringify(raw));
      expect(rolled.summary.modelTurns).toBeGreaterThan(1_000);
      expect(rawRows).toBeGreaterThan(rolledRows * 10);
    }
  }, 300_000);
});
