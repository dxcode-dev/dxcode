import { env } from "cloudflare:test";
import type {
  ThreadOrbSessionsData,
  ThreadUsageData,
  ThreadUsageRequestsData,
} from "@dx/api";
import {
  ModelUsageEventInput,
  Principal,
  type ProjectId,
  ProjectRepository,
  ThreadRepository,
  ToolUsageEventInput,
  type UsageEventInputType,
  UsagePriceMetadata,
  UsageRepository,
  type UserId,
} from "@dx/domain";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { Effect, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it } from "vitest";
import { authorizeThread } from "../../src/auth/authorize-thread.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { recordFlueUsage } from "../../src/settings/usage/recorder.js";
import { UsageRepositoryD1 } from "../../src/settings/usage/repository-d1.js";
import { TEST_RUNNER_PROFILE_CATALOG } from "../../src/testing/bindings.js";
import { threadSharingRoutes } from "../../src/thread-sharing/routes.js";
import { contextWindowOf } from "../../src/thread-usage/context-window.js";
import {
  backfillThreadUsageRollup,
  readThreadUsage,
} from "../../src/thread-usage/repository-d1.js";
import { threadUsageRoutes } from "../../src/thread-usage/routes.js";
import { countD1Calls, summarizeD1Calls } from "./d1-call-counter.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

/**
 * A Thread's Cost & Usage (migration 0161) in workerd with real D1: the
 * summary matches the usage recorded for the Thread, per connection and per
 * model, whether read from the rollup or from raw events during its
 * backfill; requests and Orb sessions page without gaps or repeats; Claude
 * Code and archived Threads say what they cannot show; only people who can
 * open the Thread see it; and opening the dialog reads a bounded number of
 * D1 rows however much the Thread used.
 */

const owner = "usage-owner" as UserId;
const member = "usage-member" as UserId;
const outsider = "usage-outsider" as UserId;
const workspaceId = "usage-workspace";
const projectRow = project(
  "prj_00000000-0000-4000-8000-000000001990",
  owner,
  "usage-project",
);
const threadRow = thread(
  "thr_00000000-0000-4000-8000-000000001990",
  projectRow.id as ProjectId,
  owner,
);
const otherThread = thread(
  "thr_00000000-0000-4000-8000-000000001991",
  projectRow.id as ProjectId,
  owner,
);
const threadId = threadRow.id;

const counter = countD1Calls(env.DB);
const bindings: Bindings = {
  DB: counter.db,
  DX_RUNNER_PROFILE_CATALOG: TEST_RUNNER_PROFILE_CATALOG,
};

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set(
      "principal",
      Schema.decodeUnknownSync(Principal)({
        userId,
        credentialScopes: ["personal", "workspace"],
      }),
    );
    await next();
  });
  app.route("/v1/threads", threadSharingRoutes);
  // As app.ts mounts them.
  app.use("/v1/threads/:threadId/usage/*", authorizeThread);
  app.route("/v1/threads", threadUsageRoutes);
  app.onError(errorHandler);
  return app;
};

const get = async <T>(userId: UserId, path: string) => {
  const response = await createApp(userId).request(
    path,
    { headers: { cookie: "dx-test=1" } },
    bindings,
  );
  return {
    status: response.status,
    data: response.ok
      ? ((await response.json()) as { data: T }).data
      : undefined,
  };
};

const user = (id: string, name: string) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  ).bind(id, name, `${id}@example.com`);

const connection = (
  id: string,
  kind: "deployment" | "custom" | "subscription",
  scope: "personal" | "workspace",
  target: string,
  name: string,
  providerId = kind === "custom" ? "custom" : "openai",
) =>
  env.DB.prepare(
    `INSERT INTO model_connection (id, scope, target_id, name, kind,
       provider_id, base_url, format, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, '2026-01-01', '2026-01-01')`,
  ).bind(
    id,
    scope,
    target,
    name,
    kind,
    providerId,
    kind === "custom" ? "https://models.example.com/v1" : null,
    kind === "custom" ? "openai-completions" : null,
  );

const price = (modelId: string) =>
  Schema.decodeUnknownSync(UsagePriceMetadata)({
    providerId: "openai",
    modelId,
    currency: "USD",
    source: "deployment",
    sourceVersion: "thread-usage-1",
    inputMicrosPerMillion: 2_000_000,
    outputMicrosPerMillion: 8_000_000,
    cacheReadMicrosPerMillion: 200_000,
    cacheWriteMicrosPerMillion: 2_500_000,
    effectiveFrom: "2026-01-01T00:00:00.000Z",
    effectiveTo: null,
    freshUntil: "2027-01-01T00:00:00.000Z",
    estimated: true,
  });

const START = Date.parse("2026-11-10T03:00:00.000Z");

/** A model turn: route, model, and tokens vary with `index`. */
const modelEvent = (
  index: number,
  options: {
    readonly thread?: string;
    readonly connectionId: string;
    readonly modelId: string;
    readonly purpose?: "agent" | "compaction" | "compaction_prefix";
    readonly at?: number;
  },
) =>
  Schema.decodeUnknownSync(ModelUsageEventInput)({
    id: `thread-usage-${options.thread ?? threadId}-${index}`,
    kind: "model",
    threadId: options.thread ?? threadId,
    occurredAt: new Date(options.at ?? START + index * 1_237).toISOString(),
    outcome: index % 11 === 0 ? "error" : "success",
    durationMs: 900,
    submissionId: `sub-${index}`,
    turnId: `turn-${index}`,
    purpose: options.purpose ?? "agent",
    observedProviderId: "openai",
    observedProviderName: "OpenAI",
    observedModelId: options.modelId,
    routeAttribution: {
      connectionId: options.connectionId,
      providerId: "openai",
      modelId: options.modelId,
    },
    inputTokens: 80 + (index % 7) * 13,
    outputTokens: 5 + (index % 5) * 9,
    cacheReadTokens: index % 3 === 0 ? 0 : 34_000 + index,
    cacheWriteTokens: index % 4 === 0 ? 1_200 : 0,
    cacheWrite1hTokens: null,
    reasoningTokens: null,
    totalTokens: 1_000,
  });

const toolEvent = (index: number) =>
  Schema.decodeUnknownSync(ToolUsageEventInput)({
    id: `thread-usage-tool-${index}`,
    kind: "tool",
    threadId,
    occurredAt: new Date(START + index * 911).toISOString(),
    outcome: "success",
    durationMs: 30,
    submissionId: `sub-${index}`,
    toolCallId: `call-${index}`,
    toolName: "bash",
    toolOrigin: "model",
    runtime: "flue",
  });

const record = (events: ReadonlyArray<UsageEventInputType>) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      for (const event of events)
        yield* repository.record(
          event,
          event.kind === "model" && event.observedModelId !== "unpriced"
            ? price(event.observedModelId)
            : undefined,
        );
    }).pipe(Effect.provide(UsageRepositoryD1(env.DB))),
  );

/** What the recorded usage_event rows of a Thread add up to, from raw rows. */
const recorded = async (thread: string) => {
  const { results } = await env.DB.prepare(
    `SELECT connection_id, observed_model_id AS model_id, COUNT(*) AS requests,
       SUM(COALESCE(input_tokens, 0)) AS input,
       SUM(COALESCE(cache_read_tokens, 0)) AS cache_read,
       SUM(COALESCE(cache_write_tokens, 0)) AS cache_write,
       SUM(COALESCE(output_tokens, 0)) AS output,
       SUM(COALESCE(estimated_cost_micros_snapshot, 0)) AS cost,
       SUM(turn_purpose = 'compaction' AND outcome = 'success') AS compactions
     FROM usage_event WHERE kind = 'model' AND thread_id = ?
     GROUP BY connection_id, observed_model_id`,
  )
    .bind(thread)
    .all<{
      connection_id: string;
      model_id: string;
      requests: number;
      input: number;
      cache_read: number;
      cache_write: number;
      output: number;
      cost: number;
      compactions: number;
    }>();
  return results;
};

const sum = <T>(rows: ReadonlyArray<T>, pick: (row: T) => number) =>
  rows.reduce((total, row) => total + pick(row), 0);

beforeEach(async () => {
  await env.DB.batch([
    user(owner, "Ada Owner"),
    user(member, "Ben Member"),
    user(outsider, "Cy Outsider"),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Usage Team', 'usage-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('u-owner', ?1, ?2, 'owner', 1), ('u-member', ?1, ?3, 'member', 2)`,
    ).bind(workspaceId, owner, member),
    connection("conn-dx", "deployment", "workspace", workspaceId, "dx models"),
    connection("conn-url", "custom", "workspace", workspaceId, "Team Gateway"),
    connection("conn-sub", "subscription", "personal", owner, "My Plan"),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      yield* (yield* ProjectRepository).insert(projectRow);
      yield* (yield* ThreadRepository).insert(threadRow);
      yield* (yield* ThreadRepository).insert(otherThread);
    }),
  );
});

const routes = ["conn-dx", "conn-url", "conn-sub"] as const;
const models = ["gpt-luna", "gpt-terra", "unpriced"] as const;

const recordMix = (count: number) =>
  record([
    ...Array.from({ length: count }, (_, index) =>
      modelEvent(index, {
        connectionId: routes[index % routes.length] as string,
        modelId: models[(index >> 1) % models.length] as string,
        purpose: index % 17 === 5 ? "compaction" : "agent",
      }),
    ),
    // Tool calls and another Thread's turns must not count.
    ...Array.from({ length: count }, (_, index) => toolEvent(index)),
    ...Array.from({ length: 20 }, (_, index) =>
      modelEvent(10_000 + index, {
        thread: otherThread.id,
        connectionId: "conn-dx",
        modelId: "gpt-luna",
      }),
    ),
  ]);

describe("Thread Cost & Usage in workerd with real D1", () => {
  it("adds up to the usage recorded for the Thread, per connection and per model", async () => {
    await recordMix(90);
    const rows = await recorded(threadId);
    const { status, data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    expect(status).toBe(200);
    if (data === undefined) throw new Error("Expected usage");
    expect(data.requests).toBe(90);
    expect(data.tokens).toEqual({
      input: sum(rows, (row) => row.input),
      cacheRead: sum(rows, (row) => row.cache_read),
      cacheWrite: sum(rows, (row) => row.cache_write),
      output: sum(rows, (row) => row.output),
    });
    const deployment = rows.filter((row) => row.connection_id === "conn-dx");
    const brought = rows.filter((row) => row.connection_id !== "conn-dx");
    expect(data.listPriceMicros).toBe(sum(rows, (row) => row.cost));
    expect(data.listPriceMicros).toBeGreaterThan(0);
    // dx pays for its own connection's turns; the rest is bring-your-own-key.
    expect(data.totalMicros).toBe(sum(deployment, (row) => row.cost));
    expect(data.byokListPriceMicros).toBe(sum(brought, (row) => row.cost));
    expect(
      Object.fromEntries(
        data.routes.map((route) => [
          route.connectionId,
          [
            route.kind,
            route.scope,
            route.ownerName,
            route.requests,
            route.listPriceMicros,
          ],
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        routes.map((id) => {
          const mine = rows.filter((row) => row.connection_id === id);
          return [
            id,
            [
              {
                "conn-dx": "deployment",
                "conn-url": "custom",
                "conn-sub": "subscription",
              }[id],
              id === "conn-sub" ? "personal" : "workspace",
              id === "conn-sub" ? "Ada Owner" : "Usage Team",
              sum(mine, (row) => row.requests),
              sum(mine, (row) => row.cost),
            ],
          ];
        }),
      ),
    );
    expect(
      Object.fromEntries(
        data.models.map((model) => [
          model.modelId,
          [
            model.requests,
            model.inputTokens,
            model.cacheReadTokens,
            model.outputTokens,
            model.listPriceMicros,
            model.dxCostMicros,
            model.unpricedRequests,
          ],
        ]),
      ),
    ).toEqual(
      Object.fromEntries(
        models.map((id) => {
          const mine = rows.filter((row) => row.model_id === id);
          return [
            id,
            [
              sum(mine, (row) => row.requests),
              sum(mine, (row) => row.input),
              sum(mine, (row) => row.cache_read),
              sum(mine, (row) => row.output),
              sum(mine, (row) => row.cost),
              sum(
                mine.filter((row) => row.connection_id === "conn-dx"),
                (row) => row.cost,
              ),
              id === "unpriced" ? sum(mine, (row) => row.requests) : 0,
            ],
          ];
        }),
      ),
    );

    // The same summary from raw events, as during the backfill, and after
    // the backfill rebuilt the rollup from those events.
    await env.DB.batch([
      env.DB.prepare("DELETE FROM usage_thread_model"),
      env.DB.prepare(
        "UPDATE usage_thread_rollup_backfill SET through_rowid = 0, end_rowid = (SELECT MAX(rowid) FROM usage_event)",
      ),
    ]);
    const raw = await readThreadUsage(
      env.DB,
      threadId,
      TEST_RUNNER_PROFILE_CATALOG,
    );
    expect(raw).toEqual(data);
    expect(await backfillThreadUsageRollup(env.DB, 10, 37)).toBe(true);
    expect(
      await readThreadUsage(env.DB, threadId, TEST_RUNNER_PROFILE_CATALOG),
    ).toEqual(data);
  });

  it("counts the deployment's own Workers AI connection as dx paying", async () => {
    await record(
      Array.from({ length: 6 }, (_, index) =>
        modelEvent(index, {
          connectionId: "deployment-workers-ai",
          modelId: "gpt-luna",
        }),
      ),
    );
    const rows = await recorded(threadId);
    const { data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    expect(data?.routes).toEqual([
      {
        connectionId: "deployment-workers-ai",
        name: "Cloudflare Workers AI",
        kind: "deployment",
        scope: null,
        ownerName: null,
        requests: 6,
        listPriceMicros: sum(rows, (row) => row.cost),
      },
    ]);
    expect(data?.totalMicros).toBe(sum(rows, (row) => row.cost));
    expect(data?.byokListPriceMicros).toBe(0);
    const page = await get<ThreadUsageRequestsData>(
      owner,
      `/v1/threads/${threadId}/usage/requests?providerId=openai&modelId=gpt-luna`,
    );
    expect(
      page.data?.requests.every(
        (request) => request.routeName === "Cloudflare Workers AI",
      ),
    ).toBe(true);
    expect(
      page.data?.requests.every(
        (request) => request.dxCostMicros === (request.listPriceMicros ?? 0),
      ),
    ).toBe(true);
  });

  it("reads a bounded number of D1 rows to open, however much the Thread used", async () => {
    const reads = async () => {
      counter.reset();
      const { status } = await get<ThreadUsageData>(
        owner,
        `/v1/threads/${threadId}/usage`,
      );
      expect(status).toBe(200);
      const calls = [...counter.calls];
      return {
        ...summarizeD1Calls(calls),
        rows: sum(calls, (call) => call.rowsRead ?? 0),
        unmeasured: calls.filter((call) => call.rowsRead === undefined).length,
      };
    };
    await recordMix(30);
    const small = await reads();
    await recordMix(300);
    const large = await reads();
    // Authorization's reads, then one batch: the backfill state, the
    // Thread's rollup rows, its Orb usage, its context window, its row.
    expect(large.roundTrips).toBe(small.roundTrips);
    expect(large.statements).toBe(small.statements);
    expect(large.rows).toBe(small.rows);
    // Measured 2026-11-10: authorization's one read, then one batch of five
    // statements; 23 rows either way.
    expect(large).toMatchObject({
      roundTrips: 2,
      statements: 6,
      unmeasured: 0,
    });
    expect(large.rows).toBeLessThanOrEqual(30);
  }, 60_000);

  it("pages a model's requests newest first, 50 at a time, reading one page of rows", async () => {
    await record(
      Array.from({ length: 120 }, (_, index) =>
        modelEvent(index, { connectionId: "conn-url", modelId: "gpt-luna" }),
      ),
    );
    await record(
      Array.from({ length: 40 }, (_, index) =>
        modelEvent(500 + index, {
          connectionId: "conn-dx",
          modelId: "gpt-terra",
        }),
      ),
    );
    const seen: string[] = [];
    const pages: number[] = [];
    const rowsRead: number[] = [];
    let cursor: string | null | undefined;
    do {
      counter.reset();
      const { status, data } = await get<ThreadUsageRequestsData>(
        owner,
        `/v1/threads/${threadId}/usage/requests?providerId=openai&modelId=gpt-luna${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`,
      );
      rowsRead.push(counter.calls.at(-1)?.rowsRead ?? Number.POSITIVE_INFINITY);
      expect(status).toBe(200);
      if (data === undefined) throw new Error("Expected a page");
      pages.push(data.requests.length);
      seen.push(...data.requests.map((request) => request.id));
      expect(
        data.requests.every((request) => request.routeName === "Team Gateway"),
      ).toBe(true);
      expect(data.requests.every((request) => request.dxCostMicros === 0)).toBe(
        true,
      );
      cursor = data.nextCursor;
    } while (cursor !== null);
    expect(pages).toEqual([50, 50, 20]);
    expect(new Set(seen).size).toBe(120);
    const times = seen.map((id) => Number(id.split("-").at(-1)));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    // Each page reads its own rows from the index, plus the connection join.
    for (const rows of rowsRead) expect(rows).toBeLessThanOrEqual(2 * 51 + 2);
  });

  it("shows a Claude Code Thread's notice and no context window", async () => {
    await env.DB.prepare("UPDATE threads SET model_selection = ? WHERE id = ?")
      .bind(
        JSON.stringify({ kind: "model", model: "claude-code/claude-opus-5-5" }),
        threadId,
      )
      .run();
    const { data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    expect(data?.claudeCode).toBe(true);
    expect(data?.context).toEqual({ available: false, reason: "claude-code" });
  });

  it("estimates the context window from the last agent request, and not for an archived Thread", async () => {
    const context = { env: bindings } as unknown as FlueEventContext;
    const info = {
      providerId: "anthropic",
      providerName: "Anthropic",
      requestedModel: "claude-opus-5-5",
      api: "anthropic-messages",
    };
    const system = "You are dx. ".repeat(400);
    const toolSearch = {
      name: "tool_search",
      description:
        "Search MCP tools.\ngithub — GitHub MCP server: create_issue, list_issues\nlinear — Linear MCP server: create_issue",
      parameters: { type: "object" },
    };
    const bash = {
      name: "bash",
      description: "Run a command. ".repeat(100),
      parameters: {
        type: "object",
        properties: { command: { type: "string" } },
      },
    };
    const event = (fields: Record<string, unknown>) =>
      ({
        v: 3,
        eventIndex: 0,
        timestamp: "2026-11-10T03:30:00.000Z",
        instanceId: threadId,
        ...fields,
      }) as unknown as FlueObservation;
    await recordFlueUsage(
      event({
        type: "turn_request",
        turnId: "ctx-1",
        purpose: "agent",
        request: {
          ...info,
          input: {
            systemPrompt: system,
            messages: [{ role: "user", content: "hello" }],
            tools: [bash, toolSearch],
          },
        },
      }),
      context,
    );
    await recordFlueUsage(
      event({
        type: "turn",
        turnId: "ctx-1",
        purpose: "agent",
        durationMs: 800,
        request: info,
        response: {
          responseModel: "claude-opus-5-5",
          usage: {
            input: 300,
            output: 120,
            cacheRead: 9_000,
            cacheWrite: 700,
            totalTokens: 10_120,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        isError: false,
      }),
      context,
    );
    const { data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    const window = data?.context;
    if (window?.available !== true)
      throw new Error("Expected a context window");
    expect(window.systemPromptTokens).toBe(Math.ceil(system.length / 4));
    expect(window.mcpServers.map((server) => server.server)).toEqual([
      "github",
      "linear",
    ]);
    expect(window.builtinToolTokens).toBeGreaterThan(
      Math.ceil(bash.description.length / 4),
    );
    // The measured request plus its reply, split into its parts.
    expect(window.usedTokens).toBe(300 + 9_000 + 700 + 120);
    expect(window.maxTokens).toBe(
      contextWindowOf("anthropic", "claude-opus-5-5"),
    );
    expect(window.maxTokens).toBeGreaterThan(window.usedTokens);
    expect(window.modelName).not.toBe("");

    // A provider can measure less input than the estimate of the system
    // prompt and tools alone; the parts then shrink to fit, and still add up
    // to exactly what it measured plus the reply.
    await recordFlueUsage(
      event({
        type: "turn_request",
        turnId: "ctx-2",
        purpose: "agent",
        timestamp: "2026-11-10T03:31:00.000Z",
        request: {
          ...info,
          input: {
            systemPrompt: system,
            messages: [{ role: "user", content: "again" }],
            tools: [bash, toolSearch],
          },
        },
      }),
      context,
    );
    await recordFlueUsage(
      event({
        type: "turn",
        turnId: "ctx-2",
        purpose: "agent",
        timestamp: "2026-11-10T03:31:00.000Z",
        durationMs: 500,
        request: info,
        response: {
          responseModel: "claude-opus-5-5",
          usage: {
            input: 7,
            output: 3,
            cacheRead: 1_001,
            cacheWrite: 0,
            totalTokens: 1_011,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
        },
        isError: false,
      }),
      context,
    );
    const shrunk = (
      await get<ThreadUsageData>(owner, `/v1/threads/${threadId}/usage`)
    ).data?.context;
    if (shrunk?.available !== true)
      throw new Error("Expected a context window");
    expect(shrunk.usedTokens).toBe(7 + 1_001 + 3);
    expect(shrunk.systemPromptTokens).toBeLessThan(
      Math.ceil(system.length / 4),
    );

    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived', archived_at = 1 WHERE id = ?",
    )
      .bind(threadId)
      .run();
    const archived = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    expect(archived.data?.context).toEqual({
      available: false,
      reason: "archived",
    });
  });

  it("says the context is not loaded before any agent request", async () => {
    const { data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${otherThread.id}/usage`,
    );
    expect(data?.context).toEqual({ available: false, reason: "not-loaded" });
    expect(data?.orb).toBeNull();
    expect(data?.requests).toBe(0);
  });

  it("sums the Thread's Orb sessions and pages them newest first", async () => {
    await env.DB.batch(
      Array.from({ length: 55 }, (_, index) =>
        env.DB.prepare(
          `INSERT INTO thread_orb_session (thread_id, started_at, ended_at,
             provider, runner_profile_id, billing, cost_micros)
           VALUES (?, ?, ?, 'e2b', 'a1.medium', ?, ?)`,
        ).bind(
          threadId,
          START + index * 3_600_000,
          START + index * 3_600_000 + 60_000 + index,
          index % 5 === 0 ? "credits" : "deployment",
          1_000 + index,
        ),
      ),
    );
    const { data } = await get<ThreadUsageData>(
      owner,
      `/v1/threads/${threadId}/usage`,
    );
    expect(data?.orb).toMatchObject({
      sessions: 55,
      runtimeMs: 55 * 60_000 + (54 * 55) / 2,
      costMicros: 55 * 1_000 + (54 * 55) / 2,
      creditsMicros: Array.from({ length: 11 }, (_, k) => 1_000 + k * 5).reduce(
        (a, b) => a + b,
        0,
      ),
      runnerProfileId: "a1.medium",
    });
    expect(data?.creditsMicros).toBe(data?.orb?.creditsMicros);
    expect(data?.totalMicros).toBe(data?.orb?.costMicros);
    const first = await get<ThreadOrbSessionsData>(
      owner,
      `/v1/threads/${threadId}/usage/orb-sessions`,
    );
    expect(first.data?.sessions).toHaveLength(50);
    expect(first.data?.sessions[0]?.runtimeMs).toBe(60_054);
    const second = await get<ThreadOrbSessionsData>(
      owner,
      `/v1/threads/${threadId}/usage/orb-sessions?cursor=${first.data?.nextCursor}`,
    );
    expect(second.data?.sessions.map((session) => session.runtimeMs)).toEqual([
      60_004, 60_003, 60_002, 60_001, 60_000,
    ]);
    expect(second.data?.nextCursor).toBeNull();
  });

  it("shows costs to whoever may open the Thread and nobody else", async () => {
    await recordMix(9);
    const path = `/v1/threads/${threadId}/usage`;
    expect((await get(outsider, path)).status).toBe(404);
    expect((await get(member, path)).status).toBe(404);
    expect(
      (await get(member, `${path}/requests?providerId=openai&modelId=gpt-luna`))
        .status,
    ).toBe(404);
    expect((await get(member, `${path}/orb-sessions`)).status).toBe(404);
    expect((await get(member, `${path}/orb-metrics`)).status).toBe(404);
    const shared = await createApp(owner).request(
      `/v1/threads/${threadId}/sharing`,
      {
        method: "PUT",
        headers: { "content-type": "application/json", cookie: "dx-test=1" },
        body: JSON.stringify({ workspaceAccess: "view" }),
      },
      bindings,
    );
    expect(shared.status).toBe(200);
    const viewer = await get<ThreadUsageData>(member, path);
    expect(viewer.status).toBe(200);
    expect(viewer.data?.requests).toBe(9);
    expect((await get(outsider, path)).status).toBe(404);
  });
});
