import { env } from "cloudflare:test";
import {
  ModelUsageEventInput,
  normalizeUsageQuery,
  RunnerUsageEventInput,
  UsagePriceMetadata,
  UsageQuery,
  UsageRepository,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import { catalogUsagePrice } from "../../src/settings/usage/pricing.js";
import { recordFlueUsage } from "../../src/settings/usage/recorder.js";
import { UsageRepositoryD1 } from "../../src/settings/usage/repository-d1.js";
import { purgeExpiredUsageEvents } from "../../src/settings/usage/retention.js";

const owner = Schema.decodeUnknownSync(UserId)("usage-owner");
const otherOwner = Schema.decodeUnknownSync(UserId)("usage-other");
const projectId = "prj_00000000-0000-4000-8000-000000000038" as const;
const threadA = "thr_00000000-0000-4000-8000-000000000038" as const;
const threadB = "thr_00000000-0000-4000-8000-000000000039" as const;
const otherThread = "thr_00000000-0000-4000-8000-000000000040" as const;

const runUsage = <A, E>(effect: Effect.Effect<A, E, UsageRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(UsageRepositoryD1(env.DB))));

const price = Schema.decodeUnknownSync(UsagePriceMetadata)({
  providerId: "openai",
  modelId: "gpt-5.2",
  currency: "USD",
  source: "deployment",
  sourceVersion: "pricing-2026-08",
  inputMicrosPerMillion: 2_000_000,
  outputMicrosPerMillion: 8_000_000,
  cacheReadMicrosPerMillion: 200_000,
  cacheWriteMicrosPerMillion: 2_500_000,
  effectiveFrom: "2026-07-01T00:00:00.000Z",
  effectiveTo: null,
  freshUntil: "2026-08-02T23:59:59.999Z",
  estimated: true,
});

const modelEvent = (
  id: string,
  threadId: typeof threadA | typeof threadB,
  occurredAt: string,
  tokens:
    | {
        readonly input: number;
        readonly output: number;
        readonly cacheRead: number;
        readonly cacheWrite: number;
        readonly total: number;
      }
    | undefined,
  identity: {
    readonly providerId: string;
    readonly providerName: string;
    readonly modelId: string;
  } = {
    providerId: "openai",
    providerName: "OpenAI",
    modelId: "gpt-5.2",
  },
  routeAttribution?: {
    readonly connectionId: string;
    readonly providerId: string;
    readonly modelId: string;
  },
) =>
  Schema.decodeUnknownSync(ModelUsageEventInput)({
    id,
    kind: "model",
    threadId,
    occurredAt,
    outcome: "success",
    durationMs: 800,
    submissionId: "sub-usage",
    turnId: id,
    purpose: "agent",
    observedProviderId: identity.providerId,
    observedProviderName: identity.providerName,
    observedModelId: identity.modelId,
    routeAttribution,
    inputTokens: tokens?.input ?? null,
    outputTokens: tokens?.output ?? null,
    cacheReadTokens: tokens?.cacheRead ?? null,
    cacheWriteTokens: tokens?.cacheWrite ?? null,
    reasoningTokens: null,
    totalTokens: tokens?.total ?? null,
  });

const query = async (
  overrides: Record<string, unknown> = {},
  ownerUserId = owner,
) => {
  const decoded = Schema.decodeUnknownSync(UsageQuery)({
    from: "2026-08-01",
    to: "2026-08-31",
    timezoneOffsetMinutes: 330,
    ...overrides,
  });
  const normalized = await Effect.runPromise(normalizeUsageQuery(decoded));
  return runUsage(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return yield* repository.dashboard(ownerUserId, normalized);
    }),
  );
};

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      projectId,
      owner,
      "Usage project",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "prj_00000000-0000-4000-8000-000000000040",
      otherOwner,
      "Other usage project",
      "2026-07-01T00:00:00.000Z",
      "2026-07-01T00:00:00.000Z",
    ),
    ...[
      [threadA, projectId, owner, "2026-08-01T02:30:00.000Z"],
      [threadB, projectId, owner, "2026-08-02T09:00:00.000Z"],
      [
        otherThread,
        "prj_00000000-0000-4000-8000-000000000040",
        otherOwner,
        "2026-08-02T09:00:00.000Z",
      ],
    ].map(([id, ownedProject, ownedBy, createdAt]) =>
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind(id, ownedProject, ownedBy, createdAt, createdAt),
    ),
  ]);
});

describe("usage observability D1", () => {
  it("prices a proxied turn from its canonical route rather than its observed alias", async () => {
    const canonicalPrice = catalogUsagePrice(
      "cloudflare",
      "@cf/zai-org/glm-5.3-flash",
    );
    if (canonicalPrice === undefined)
      throw new Error("Expected canonical catalog price.");
    const effectiveFrom = Schema.encodeSync(Schema.DateTimeUtcFromString)(
      canonicalPrice.effectiveFrom,
    );
    const fetch = async () =>
      Response.json({
        connectionId: "mcon_usage",
        providerId: "cloudflare",
        modelId: "@cf/zai-org/glm-5.3-flash",
      });
    await recordFlueUsage(
      {
        type: "turn",
        timestamp: new Date(Date.parse(effectiveFrom) + 1_000).toISOString(),
        instanceId: threadA,
        submissionId: "sub-priced-route",
        turnId: "turn-priced-route",
        purpose: "agent",
        durationMs: 10,
        isError: false,
        request: {
          providerId: "custom-proxy",
          providerName: "Custom proxy",
          requestedModel: "opaque-upstream-alias",
        },
        response: {
          responseModel: "opaque-upstream-alias",
          usage: {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 1_000_000,
          },
        },
      } as never,
      {
        env: {
          DB: env.DB,
          BYOK_CREDENTIAL_COORDINATOR: {
            idFromName: () => ({ id: "usage-coordinator" }),
            get: () => ({ fetch }),
          },
        },
      } as never,
    );

    await expect(
      env.DB.prepare(
        `SELECT provider_id, model_id, observed_provider_id, observed_model_id,
                price_status, price_source, estimated_cost_micros_snapshot
         FROM usage_event WHERE id = ?`,
      )
        .bind(`flue:model:${threadA}:turn-priced-route`)
        .first(),
    ).resolves.toMatchObject({
      provider_id: "cloudflare",
      model_id: "@cf/zai-org/glm-5.3-flash",
      observed_provider_id: "custom-proxy",
      observed_model_id: "opaque-upstream-alias",
      price_status: "fresh",
      price_source: "catalog",
      estimated_cost_micros_snapshot: canonicalPrice.inputMicrosPerMillion,
    });
  });

  it("retains the base usage event when route attribution is unavailable", async () => {
    await recordFlueUsage(
      {
        type: "turn",
        timestamp: "2026-10-01T10:01:00.000Z",
        instanceId: threadA,
        submissionId: "sub-attribution-unavailable",
        turnId: "turn-attribution-unavailable",
        purpose: "agent",
        durationMs: 11,
        isError: false,
        request: {
          providerId: "cloudflare",
          providerName: "Cloudflare Workers AI",
          requestedModel: "@cf/zai-org/glm-5.3-flash",
        },
        response: {
          responseModel: "@cf/zai-org/glm-5.3-flash",
          usage: { input: 2, output: 1, totalTokens: 3 },
        },
      } as never,
      {
        env: {
          DB: env.DB,
          BYOK_CREDENTIAL_COORDINATOR: {
            idFromName: () => ({ id: "usage-coordinator" }),
            get: () => ({
              fetch: async () => new Response(null, { status: 503 }),
            }),
          },
        },
      } as never,
    );

    await expect(
      env.DB.prepare(
        "SELECT provider_id, model_id, total_tokens FROM usage_event WHERE id = ?",
      )
        .bind(`flue:model:${threadA}:turn-attribution-unavailable`)
        .first(),
    ).resolves.toEqual({
      provider_id: "unresolved",
      model_id: "unresolved",
      total_tokens: 3,
    });
  });

  it("persists immutable submission route identity instead of mutable selection or observed upstream identity", async () => {
    await env.DB.prepare("UPDATE threads SET model_selection = ? WHERE id = ?")
      .bind(JSON.stringify({ kind: "model", model: "mutable/wrong" }), threadA)
      .run();
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(
          modelEvent(
            "usage-canonical-route",
            threadA,
            "2026-08-01T00:00:00.000Z",
            { input: 1, output: 2, cacheRead: 0, cacheWrite: 0, total: 3 },
            {
              providerId: "upstream-proxy",
              providerName: "Observed proxy",
              modelId: "rewritten-model",
            },
            {
              connectionId: "conn-exact",
              providerId: "anthropic",
              modelId: "claude-canonical",
            },
          ),
        );
      }),
    );
    await expect(
      env.DB.prepare(
        "SELECT connection_id, provider_id, model_id, observed_provider_id, observed_model_id FROM usage_event WHERE id = ?",
      )
        .bind("usage-canonical-route")
        .first(),
    ).resolves.toEqual({
      connection_id: "conn-exact",
      provider_id: "anthropic",
      model_id: "claude-canonical",
      observed_provider_id: "upstream-proxy",
      observed_model_id: "rewritten-model",
    });
  });

  it("keeps an immutable, content-free ledger with retention deletion available", async () => {
    const schema = await env.DB.prepare(
      "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'usage_event'",
    ).first<{ sql: string }>();
    expect(schema?.sql).not.toMatch(
      /prompt|response|message|payload|arguments|result/i,
    );
    expect(schema?.sql).toContain("observed_provider_id");
    expect(schema?.sql).toContain("model_profile_version");
    expect(schema?.sql).toContain("runner_profile_id");
    expect(schema?.sql).toContain("expires_at");

    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(
          modelEvent(
            "usage-content-free",
            threadA,
            "2026-08-01T00:00:00.000Z",
            { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, total: 2 },
          ),
        );
      }),
    );
    await expect(
      env.DB.prepare("UPDATE usage_event SET duration_ms = 1 WHERE id = ?")
        .bind("usage-content-free")
        .run(),
    ).rejects.toBeDefined();
    await expect(
      purgeExpiredUsageEvents(env.DB, "2027-01-29T00:00:00.000Z"),
    ).resolves.toMatchObject({ success: true, meta: { changes: 1 } });
    await expect(
      env.DB.prepare("SELECT id FROM usage_event WHERE id = ?")
        .bind("usage-content-free")
        .first(),
    ).resolves.toBeNull();
  });

  it("attributes snapshots and observed calls, applies effective prices, and keeps stale prices unknown", async () => {
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(
          modelEvent("usage-priced", threadA, "2026-07-31T18:30:00.000Z", {
            input: 1_000_000,
            output: 250_000,
            cacheRead: 500_000,
            cacheWrite: 0,
            total: 1_750_000,
          }),
          price,
        );
        yield* repository.record(
          modelEvent(
            "usage-stale",
            threadA,
            "2026-08-03T00:00:00.000Z",
            undefined,
          ),
          price,
        );
        yield* repository.record(
          modelEvent(
            "usage-stale-with-complete-counts",
            threadA,
            "2026-08-03T00:00:01.000Z",
            { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
          ),
          price,
        );
        yield* repository.record(
          modelEvent(
            "usage-before-local-boundary",
            threadA,
            "2026-07-31T18:29:59.999Z",
            { input: 9, output: 9, cacheRead: 0, cacheWrite: 0, total: 18 },
          ),
          price,
        );
        yield* repository.record(
          modelEvent(
            "usage-before-price-effective-date",
            threadA,
            "2026-06-30T12:00:00.000Z",
            { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, total: 12 },
          ),
          price,
        );
      }),
    );

    const dashboard = await query({ threadId: threadA });
    expect(dashboard.summary.tokens).toMatchObject({
      total: 1_750_100,
      unknownEvents: 1,
    });
    expect(dashboard.summary.estimatedCost).toEqual({
      amountMicros: 4_100_000,
      currency: "USD",
      estimated: true,
      knownEvents: 1,
      unknownEvents: 2,
    });
    expect(dashboard.daily[0]).toMatchObject({
      day: "2026-08-01",
      totalTokens: 1_750_000,
      estimatedCostMicros: 4_100_000,
    });
    expect(dashboard.threads[0]).toMatchObject({
      providerId: "openai",
      modelId: "gpt-5.2",
      profileId: "medium",
      profileVersion: 1,
      runnerDurationMs: 0,
    });
    expect(dashboard.priceSources).toEqual([
      expect.objectContaining({
        source: "deployment",
        sourceVersion: "pricing-2026-08",
        currency: "USD",
        estimated: true,
      }),
    ]);
    const stalePrice = await query({
      from: "2026-08-03",
      to: "2026-08-03",
      timezoneOffsetMinutes: 0,
      threadId: threadA,
    });
    expect(stalePrice.summary.tokens).toMatchObject({
      total: 100,
      unknownEvents: 1,
    });
    expect(stalePrice.summary.estimatedCost).toMatchObject({
      knownEvents: 0,
      unknownEvents: 2,
    });
    expect(stalePrice.priceSources).toEqual([]);
    const beforeEffectiveDate = await query({
      from: "2026-06-30",
      to: "2026-06-30",
      timezoneOffsetMinutes: 0,
      threadId: threadA,
    });
    expect(beforeEffectiveDate.summary.estimatedCost).toMatchObject({
      knownEvents: 0,
      unknownEvents: 1,
    });
    expect(beforeEffectiveDate.priceSources).toEqual([]);
  });

  it("enforces owner filters and keyset-paginates expensive Threads", async () => {
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(
          modelEvent("usage-page-a", threadA, "2026-08-01T00:00:00.000Z", {
            input: 1_000_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 1_000_000,
          }),
          price,
        );
        yield* repository.record(
          modelEvent("usage-page-b", threadB, "2026-08-01T00:00:00.000Z", {
            input: 100_000,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            total: 100_000,
          }),
          price,
        );
      }),
    );

    const first = await query({ limit: 1 });
    expect(first.threads.map(({ threadId }) => threadId)).toEqual([threadA]);
    expect(first.nextCursor).toBeDefined();
    const second = await query({ limit: 1, cursor: first.nextCursor });
    expect(second.threads.map(({ threadId }) => threadId)).toEqual([threadB]);
    expect(second.nextCursor).toBeUndefined();
    await expect(query({ threadId: otherThread })).rejects.toMatchObject({
      _tag: "UsageResourceForbidden",
    });
  });

  it("filters mode-selected usage by observed provider and model identity", async () => {
    await env.DB.prepare("UPDATE threads SET model_selection = ? WHERE id = ?")
      .bind(JSON.stringify({ kind: "mode", mode: "medium" }), threadA)
      .run();
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(
          modelEvent(
            "usage-mode-observed",
            threadA,
            "2026-08-01T00:00:00.000Z",
            { input: 7, output: 5, cacheRead: 0, cacheWrite: 0, total: 12 },
          ),
        );
        yield* repository.record(
          modelEvent(
            "usage-mode-other",
            threadA,
            "2026-08-01T00:01:00.000Z",
            { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, total: 100 },
            {
              providerId: "anthropic",
              providerName: "Anthropic",
              modelId: "claude-other",
            },
          ),
        );
      }),
    );

    const dashboard = await query({
      threadId: threadA,
      providerId: "openai",
      modelId: "gpt-5.2",
    });
    expect(dashboard.summary).toMatchObject({
      tokens: { total: 12 },
      modelTurns: 1,
    });
    expect(dashboard.threads).toEqual([
      expect.objectContaining({
        providerId: "openai",
        modelId: "gpt-5.2",
        totalTokens: 12,
      }),
    ]);
  });

  it("aggregates real E2B resolution identity/resources with explicit profile unknowns", async () => {
    const event = Schema.decodeUnknownSync(RunnerUsageEventInput)({
      id: "usage-runner",
      kind: "runner",
      threadId: threadA,
      occurredAt: "2026-08-01T01:00:00.000Z",
      outcome: "success",
      durationMs: 245,
      provider: "e2b",
      decision: "connect",
      runnerId: "sandbox-real-id",
      template: "dx-workspace",
      activeTimeoutMs: 600_000,
      resources: {
        profileId: null,
        profileVersion: null,
        cpuCores: 4,
        memoryMb: 8192,
        diskGb: null,
      },
    });
    await runUsage(
      Effect.gen(function* () {
        const repository = yield* UsageRepository;
        yield* repository.record(event);
      }),
    );

    const dashboard = await query({ threadId: threadA });
    expect(dashboard.summary.runnerDurationMs).toBe(245);
    expect(dashboard.threads[0]?.runnerDurationMs).toBe(245);
    expect(dashboard.runners).toEqual([
      {
        provider: "e2b",
        profileId: null,
        profileVersion: null,
        template: "dx-workspace",
        cpuCores: 4,
        memoryMb: 8192,
        diskGb: null,
        durationMs: 245,
        events: 1,
        unknownResourceEvents: 1,
      },
    ]);
  });
});
