import { env } from "cloudflare:test";
import {
  type Api,
  type AssistantMessage,
  type Context,
  createModels,
  type Message,
  type Model,
  normalizeContext,
  type Tool,
} from "@earendil-works/pi-ai";
import type { FlueEventContext, FlueObservation } from "@flue/runtime";
import { DateTime, Effect } from "effect";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { createDxModelRoutingProvider } from "../../src/settings/model-byok/flue-provider.js";
import {
  upstreamDns,
  upstreamFetch,
} from "../../src/settings/model-byok/invocation.js";
import { modelCatalogGeneratedAt } from "../../src/settings/model-routing/catalog.js";
import { encryptModelCredential } from "../../src/settings/model-routing/model-credential-encryption.js";
import { recordFlueUsage } from "../../src/settings/usage/recorder.js";

/**
 * Anthropic's prompt-cache TTL on dx's model routing path (#1757). A Thread's
 * model calls run through the real dx provider and credential coordinator to
 * a recorded Anthropic API that keeps a prompt cache by Anthropic's
 * documented rules, so the test sees both the request dx sends and the
 * cache-read and cache-write tokens Anthropic would bill for it.
 */

const OWNER = "cache-owner";
const PROJECT = "cache-project";
const THREAD = "thr_00000000-0000-4000-8000-000000001760";
const CONNECTION = "mcon_cache";
const CREDENTIAL = "mcred_cache";
const MODEL = "claude-sonnet-5-5";
const API_KEY = "sk-ant-api-cache-test";
const CUSTOM_ENDPOINT = "https://claude-gateway.test";
const now = "2026-11-05T00:00:00.000Z";

const realFetch = upstreamFetch.current;
const realDns = upstreamDns.current;
beforeEach(() => {
  upstreamDns.current = async () => ["8.8.8.8"];
});
afterEach(() => {
  upstreamFetch.current = realFetch;
  upstreamDns.current = realDns;
});

const coordinator = () =>
  env.BYOK_CREDENTIAL_COORDINATOR.get(
    env.BYOK_CREDENTIAL_COORDINATOR.idFromName(`byok-${THREAD}`),
  );

/** An Anthropic key connection, or a custom Anthropic-wire endpoint serving Claude. */
const seed = async (connection: "anthropic" | "custom") => {
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(env as never),
  );
  const envelope = await Effect.runPromise(
    encryptModelCredential(
      keyring,
      {
        id: CREDENTIAL as never,
        target: { scope: "personal", id: OWNER as never },
        name: "anthropic-key",
      },
      API_KEY as never,
    ),
  );
  await env.DB.batch([
    env.DB.prepare("DELETE FROM model_connection_model"),
    env.DB.prepare("DELETE FROM model_connection"),
    env.DB.prepare("DELETE FROM model_credential"),
    env.DB.prepare("DELETE FROM threads"),
    env.DB.prepare("DELETE FROM projects"),
    env.DB.prepare('DELETE FROM "user"'),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(OWNER, "Owner", "cache-owner@dx.test", now, now),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(PROJECT, OWNER, "Cache project", now, now),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, model_selection, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      THREAD,
      PROJECT,
      OWNER,
      JSON.stringify({ kind: "model", model: `anthropic/${MODEL}` }),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO model_credential (id, scope, target_id, name, envelope_version, key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      CREDENTIAL,
      OWNER,
      "anthropic-key",
      envelope.version,
      envelope.keyVersion,
      envelope.valueNonce,
      envelope.ciphertext,
      envelope.wrappedKeyNonce,
      envelope.wrappedKey,
      now,
      now,
    ),
    connection === "anthropic"
      ? env.DB.prepare(
          "INSERT INTO model_connection (id, scope, target_id, name, kind, provider_id, fields, enabled, priority, model_credential_id, created_at, updated_at) VALUES (?, 'personal', ?, 'Anthropic', 'provider', 'anthropic', '{}', 1, 0, ?, ?, ?)",
        ).bind(CONNECTION, OWNER, CREDENTIAL, now, now)
      : env.DB.prepare(
          "INSERT INTO model_connection (id, scope, target_id, name, kind, provider_id, base_url, format, fields, enabled, priority, model_credential_id, created_at, updated_at) VALUES (?, 'personal', ?, 'Claude gateway', 'custom', 'dx-custom', ?, 'anthropic-messages', '{}', 1, 0, ?, ?, ?)",
        ).bind(CONNECTION, OWNER, CUSTOM_ENDPOINT, CREDENTIAL, now, now),
    ...(connection === "custom"
      ? [
          env.DB.prepare(
            "INSERT INTO model_connection_model (connection_id, canonical, upstream, position) VALUES (?, ?, ?, 0)",
          ).bind(CONNECTION, `anthropic/${MODEL}`, MODEL),
        ]
      : []),
  ]);
};

/** dx's provider for the Thread, with the model its connection serves. */
const routedModel = async (submissionId: string) => {
  const prepared = await coordinator().fetch("https://coordinator/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      threadId: THREAD,
      submissionId,
      recovery: false,
    }),
  });
  expect(prepared.status).toBe(200);
  await prepared.arrayBuffer();
  const { provider, options } = createDxModelRoutingProvider("anthropic", {
    namespace: env.BYOK_CREDENTIAL_COORDINATOR,
    identity: () => ({ name: THREAD }) as never,
    invocation: () => ({ scope: { kind: "prompt", submissionId } }) as never,
  });
  assert.exists(options.resolveModel);
  const model = await options.resolveModel(
    { providerId: "anthropic", modelId: MODEL },
    {
      instanceId: THREAD,
      agentName: "dx-agent",
      recovery: false,
      scope: { kind: "prompt", submissionId },
      signal: new AbortController().signal,
    },
  );
  if (model === undefined) throw new Error("No model served");
  const models = createModels();
  models.setProvider(provider);
  return { models, model: model as Model<Api> };
};

/** A deterministic string of about `tokens` tokens (4 characters each). */
const filler = (label: string, tokens: number) =>
  `${label}: ${"lorem ipsum dolor sit amet ".repeat(Math.ceil((tokens * 4) / 27))}`.slice(
    0,
    tokens * 4,
  );

const TOOLS: Tool[] = Array.from({ length: 12 }, (_, index) => ({
  name: `tool_${index}`,
  description: filler(`tool ${index}`, 500),
  parameters: {
    type: "object",
    properties: { input: { type: "string" } },
  } as never,
}));
const SYSTEM_PROMPT = filler("system", 9_000);

interface CachePoint {
  readonly ttlSeconds: number;
  expiresAt: number;
}

interface CallUsage {
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly cacheWrite1h: number;
  readonly input: number;
}

/**
 * Anthropic's prompt cache as its docs describe it: the prompt is tools, then
 * system, then messages; each `cache_control` block is a breakpoint with a
 * 5-minute TTL, or 1 hour with `ttl: "1h"`. A request reads the longest prefix
 * still cached that ends at most 20 blocks before one of its breakpoints, and
 * a read refreshes that entry's TTL. Everything after the read up to the last
 * breakpoint is written, each part at the TTL of the breakpoint that ends it.
 * Tokens are estimated at 4 characters each.
 */
const recordedAnthropic = () => {
  const cache = new Map<string, CachePoint>();
  let clock = 0;
  const requests: Record<string, unknown>[] = [];
  const calls: CallUsage[] = [];

  const blocks = (body: Record<string, unknown>) => {
    const tools = (body.tools ?? []) as Record<string, unknown>[];
    const system = (body.system ?? []) as Record<string, unknown>[];
    const messages = (body.messages ?? []) as {
      role: string;
      content: string | Record<string, unknown>[];
    }[];
    return [
      ...tools,
      ...system,
      ...messages.flatMap(({ role, content }) =>
        typeof content === "string"
          ? [{ role, type: "text", text: content }]
          : content.map((block) => ({ role, ...block })),
      ),
    ];
  };

  const digest = async (text: string) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)),
      ),
      (byte) => byte.toString(16).padStart(2, "0"),
    ).join("");

  const answer = async (body: Record<string, unknown>): Promise<CallUsage> => {
    const prompt = blocks(body);
    // keys[i] identifies the prompt prefix through block i.
    const keys: string[] = [];
    const ends: number[] = [];
    const breakpoints: { index: number; ttlSeconds: number }[] = [];
    let key = "";
    let tokens = 0;
    for (const [index, block] of prompt.entries()) {
      const { cache_control: control, ...content } = block as {
        cache_control?: { ttl?: string };
      };
      const text = JSON.stringify(content);
      key = await digest(`${key}${await digest(text)}`);
      keys.push(key);
      tokens += Math.ceil(text.length / 4);
      ends.push(tokens);
      if (control !== undefined)
        breakpoints.push({
          index,
          ttlSeconds: control.ttl === "1h" ? 3_600 : 300,
        });
    }
    const last = breakpoints.at(-1);
    if (last === undefined)
      return { cacheRead: 0, cacheWrite: 0, cacheWrite1h: 0, input: tokens };
    let hit = -1;
    for (const { index } of breakpoints)
      for (let at = index; at >= Math.max(0, index - 20); at -= 1) {
        const entry = cache.get(keys[at] ?? "");
        if (entry !== undefined && entry.expiresAt > clock && at > hit)
          hit = at;
      }
    const hitEntry = hit < 0 ? undefined : cache.get(keys[hit] ?? "");
    if (hitEntry !== undefined)
      hitEntry.expiresAt = clock + hitEntry.ttlSeconds * 1_000;
    const cacheRead = hit < 0 ? 0 : (ends[hit] ?? 0);
    let written = cacheRead;
    let cacheWrite = 0;
    let cacheWrite1h = 0;
    for (const { index, ttlSeconds } of breakpoints) {
      if (index <= hit) continue;
      const part = (ends[index] ?? 0) - written;
      written = ends[index] ?? 0;
      cacheWrite += part;
      if (ttlSeconds === 3_600) cacheWrite1h += part;
      cache.set(keys[index] ?? "", {
        ttlSeconds,
        expiresAt: clock + ttlSeconds * 1_000,
      });
    }
    return {
      cacheRead,
      cacheWrite,
      cacheWrite1h,
      input: tokens - (ends[last.index] ?? 0),
    };
  };

  upstreamFetch.current = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as never, init as never);
    expect(request.url).toMatch(
      /^(https:\/\/api\.anthropic\.com|https:\/\/claude-gateway\.test)\/v1\/messages/,
    );
    expect(request.headers.get("x-api-key")).toBe(API_KEY);
    const body = (await request.json()) as Record<string, unknown>;
    requests.push(body);
    const usage = await answer(body);
    calls.push(usage);
    const events = [
      {
        type: "message_start",
        message: {
          id: `msg_${calls.length}`,
          type: "message",
          role: "assistant",
          model: MODEL,
          content: [],
          stop_reason: null,
          usage: {
            input_tokens: usage.input,
            cache_read_input_tokens: usage.cacheRead,
            cache_creation_input_tokens: usage.cacheWrite,
            cache_creation: {
              ephemeral_5m_input_tokens: usage.cacheWrite - usage.cacheWrite1h,
              ephemeral_1h_input_tokens: usage.cacheWrite1h,
            },
            output_tokens: 0,
          },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: `Step ${calls.length} done.` },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 200 },
      },
      { type: "message_stop" },
    ];
    return new Response(
      events
        .map(
          (event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
        )
        .join(""),
      { headers: { "content-type": "text/event-stream" } },
    );
  }) as never;

  return {
    requests,
    calls,
    advance: (milliseconds: number) => {
      clock += milliseconds;
    },
  };
};

const MINUTE = 60_000;

/**
 * One Thread's model calls. `waits` is the time before each call: the agent
 * calls again about 20 seconds after each answer, and a longer wait is the
 * person reading, reviewing, or away. `history` is the prompt the Thread
 * starts with besides the system prompt and tools, and `added` what each call
 * adds to it (a tool result and the answer).
 */
interface Workload {
  readonly waits: ReadonlyArray<number>;
  readonly history: number;
  readonly added: number;
}

const calls = (count: number) => Array<number>(count).fill(MINUTE / 3);

/**
 * `day` is one Thread's day on the direct Anthropic path as #1757 measured it
 * in production (2,875 calls by 20 Threads in 24 hours, a 382k-token context
 * on average, about 3.3k tokens written per call, and about two pauses of 5
 * to 60 minutes per Thread), at a tenth of the tokens: 144 calls from a cold
 * 38k-token prompt that grows about 330 tokens a call, with pauses of 15 and
 * 40 minutes. `steady` is the same calls without the pauses. `small` is a
 * short Thread whose prompt is small next to what each call adds.
 */
const WORKLOADS: Record<string, Workload> = {
  day: {
    waits: [
      0,
      ...calls(47),
      15 * MINUTE,
      ...calls(47),
      40 * MINUTE,
      ...calls(47),
    ],
    history: 23_000,
    added: 320,
  },
  steady: { waits: [0, ...calls(143)], history: 23_000, added: 320 },
  small: {
    waits: [
      0,
      ...calls(5),
      12 * MINUTE,
      ...calls(4),
      35 * MINUTE,
      ...calls(4),
      120 * MINUTE,
      ...calls(3),
    ],
    history: 0,
    added: 2_500,
  },
};

/**
 * Runs a workload through dx's routing provider. `cacheRetention` overrides
 * what dx chooses, to measure Anthropic's default 5-minute cache on the same
 * requests.
 */
const runWorkload = async (
  { waits, history, added }: Workload,
  cacheRetention?: "short",
) => {
  await seed("anthropic");
  const anthropic = recordedAnthropic();
  const { models, model } = await routedModel(`sub-${crypto.randomUUID()}`);
  const messages: Message[] = [];
  if (history > 0) {
    messages.push(
      { role: "user", content: filler("earlier work", history), timestamp: 0 },
      {
        role: "assistant",
        content: [{ type: "text", text: "Understood." }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: 0,
      },
    );
  }
  let cost = 0;
  for (const [step, wait] of waits.entries()) {
    anthropic.advance(wait);
    messages.push({
      role: "user",
      content: filler(`step ${step} tool output`, added),
      timestamp: step,
    });
    const context: Context = normalizeContext({
      systemPrompt: SYSTEM_PROMPT,
      tools: TOOLS,
      messages,
    });
    const answer: AssistantMessage = await models
      .streamSimple(
        model,
        context,
        cacheRetention === undefined ? {} : ({ cacheRetention } as never),
      )
      .result();
    expect(answer.stopReason).toBe("stop");
    cost += answer.usage.cost.total;
    messages.push(answer);
  }
  const sum = (field: keyof CallUsage) =>
    anthropic.calls.reduce((total, call) => total + call[field], 0);
  return {
    requests: anthropic.requests,
    calls: anthropic.calls.length,
    cacheReadTokens: sum("cacheRead"),
    cacheWriteTokens: sum("cacheWrite"),
    cacheWrite1hTokens: sum("cacheWrite1h"),
    // pi's own pricing of each call's usage, at Claude Sonnet 5.5's rates.
    costUsd: Number(cost.toFixed(4)),
  };
};

/** Every `cache_control` marker in an Anthropic request body, with where it sits. */
const cacheMarkers = (body: Record<string, unknown>) => {
  const markers: { at: string; control: unknown }[] = [];
  const visit = (value: unknown, at: string) => {
    if (Array.isArray(value)) {
      for (const [index, item] of value.entries())
        visit(item, `${at}[${index}]`);
      return;
    }
    if (typeof value !== "object" || value === null) return;
    for (const [field, inner] of Object.entries(value)) {
      if (field === "cache_control") markers.push({ at, control: inner });
      else visit(inner, at === "" ? field : `${at}.${field}`);
    }
  };
  visit(body, "");
  return markers;
};

describe("Anthropic prompt cache TTL", () => {
  it("asks the Anthropic API for the 1-hour cache on every breakpoint", async () => {
    const { requests } = await runWorkload({
      waits: [0, MINUTE / 3, MINUTE / 3],
      history: 0,
      added: 2_500,
    });
    expect(requests).toHaveLength(3);
    for (const body of requests) {
      const lastUser = (body.messages as { role: string }[]).findLastIndex(
        ({ role }) => role === "user",
      );
      // The same three breakpoints as the 5-minute cache: last user message,
      // system prompt, last tool.
      expect(
        cacheMarkers(body).sort((a, b) => a.at.localeCompare(b.at)),
      ).toEqual([
        {
          at: `messages[${lastUser}].content[0]`,
          control: { type: "ephemeral", ttl: "1h" },
        },
        { at: "system[0]", control: { type: "ephemeral", ttl: "1h" } },
        {
          at: `tools[${TOOLS.length - 1}]`,
          control: { type: "ephemeral", ttl: "1h" },
        },
      ]);
    }
  }, 30_000);

  it("keeps the 5-minute default for a custom endpoint serving Claude", async () => {
    await seed("custom");
    const anthropic = recordedAnthropic();
    const { models, model } = await routedModel("sub-custom");
    expect(model.baseUrl).toBe(CUSTOM_ENDPOINT);
    const answer = await models
      .streamSimple(
        model,
        normalizeContext({
          systemPrompt: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        }),
      )
      .result();
    expect(answer.stopReason).toBe("stop");
    const [body] = anthropic.requests;
    assert.exists(body);
    const markers = cacheMarkers(body);
    expect(markers).toHaveLength(3);
    for (const { control } of markers)
      expect(control).toEqual({ type: "ephemeral" });
  }, 30_000);

  it("costs less on a production-shaped day, and more without pauses of 5 to 60 minutes", async ({
    annotate,
  }) => {
    const measured: Record<
      string,
      {
        before: Awaited<ReturnType<typeof runWorkload>>;
        after: Awaited<ReturnType<typeof runWorkload>>;
      }
    > = {};
    for (const [name, workload] of Object.entries(WORKLOADS))
      measured[name] = {
        before: await runWorkload(workload, "short"),
        after: await runWorkload(workload),
      };
    const report = Object.fromEntries(
      Object.entries(measured).map(([name, { before, after }]) => {
        const { requests: _before, ...beforeTotals } = before;
        const { requests: _after, ...afterTotals } = after;
        return [
          name,
          {
            before: beforeTotals,
            after: afterTotals,
            costChange: `${(((after.costUsd - before.costUsd) / before.costUsd) * 100).toFixed(1)}%`,
          },
        ];
      }),
    );
    // The repeatable measurement this test leaves behind, in its report.
    await annotate(JSON.stringify(report), "anthropic-prompt-cache");

    const { day, steady, small } = measured;
    assert.exists(day);
    assert.exists(steady);
    assert.exists(small);
    // Both pauses now read the prompt instead of writing it again.
    expect(day.after.cacheWriteTokens).toBeLessThan(
      day.before.cacheWriteTokens,
    );
    expect(day.after.cacheReadTokens).toBeGreaterThan(
      day.before.cacheReadTokens,
    );
    expect(day.after.costUsd).toBeLessThan(day.before.costUsd);
    // Without such pauses the same tokens are written at 2× instead of 1.25×.
    expect(steady.after.cacheWriteTokens).toBe(steady.before.cacheWriteTokens);
    expect(steady.after.cacheWrite1hTokens).toBe(steady.after.cacheWriteTokens);
    expect(steady.after.costUsd).toBeGreaterThan(steady.before.costUsd);
    // A small prompt saves less at a pause than the dearer writes cost.
    expect(small.after.costUsd).toBeGreaterThan(small.before.costUsd);
  }, 300_000);
});

describe("Usage ledger for the 1-hour prompt cache", () => {
  /**
   * The `turn` observation Flue reports for a model call: pi's usage as the
   * runtime's `fromProviderUsage` passes it on, 1-hour split included
   * (third-party/flue, `usage.test.ts`).
   */
  const turnObservation = (
    turnId: string,
    occurredAt: string,
    usage: AssistantMessage["usage"],
  ) =>
    ({
      type: "turn",
      timestamp: occurredAt,
      instanceId: THREAD,
      submissionId: "sub-ledger",
      turnId,
      purpose: "agent",
      durationMs: 1_000,
      isError: false,
      request: {
        providerId: "anthropic",
        providerName: "anthropic",
        requestedModel: MODEL,
      },
      response: {
        responseModel: MODEL,
        usage: {
          input: usage.input,
          output: usage.output,
          cacheRead: usage.cacheRead,
          cacheWrite: usage.cacheWrite,
          ...(usage.cacheWrite1h === undefined
            ? {}
            : { cacheWrite1h: usage.cacheWrite1h }),
          totalTokens: usage.totalTokens,
          cost: usage.cost,
        },
      },
    }) as unknown as FlueObservation;

  const ledgerRow = (turnId: string) =>
    env.DB.prepare(
      "SELECT cache_write_tokens, cache_write_1h_tokens, estimated_cost_micros_snapshot AS cost, price_status FROM usage_event WHERE id = ?",
    )
      .bind(`flue:model:${THREAD}:${turnId}`)
      .first<{
        cache_write_tokens: number;
        cache_write_1h_tokens: number | null;
        cost: number | null;
        price_status: string;
      }>();

  it("records the 1-hour cache writes and prices them as Anthropic bills them", async () => {
    await seed("anthropic");
    recordedAnthropic();
    const { models, model } = await routedModel("sub-ledger");
    const answer = await models
      .streamSimple(
        model,
        normalizeContext({
          systemPrompt: SYSTEM_PROMPT,
          tools: TOOLS,
          messages: [{ role: "user", content: "Hello", timestamp: 0 }],
        }),
      )
      .result();
    expect(answer.stopReason).toBe("stop");
    // A first call writes its whole prompt to the 1-hour cache.
    expect(answer.usage.cacheWrite).toBeGreaterThan(0);
    expect(answer.usage.cacheWrite1h).toBe(answer.usage.cacheWrite);

    // Within the catalog price's freshness window.
    assert.exists(modelCatalogGeneratedAt);
    const occurredAt = new Date(
      DateTime.toEpochMillis(modelCatalogGeneratedAt) + 86_400_000,
    ).toISOString();
    await recordFlueUsage(
      turnObservation("turn-1h", occurredAt, answer.usage),
      { env } as unknown as FlueEventContext,
    );
    const row = await ledgerRow("turn-1h");
    assert.exists(row);
    expect(row).toMatchObject({
      cache_write_tokens: answer.usage.cacheWrite,
      cache_write_1h_tokens: answer.usage.cacheWrite1h,
      price_status: "fresh",
    });
    // The ledger's estimate is the bill pi computes from Anthropic's prices:
    // 1-hour writes at 2x input, not the catalog's 5-minute cache-write rate.
    expect(
      Math.abs((row.cost ?? 0) - answer.usage.cost.total * 1_000_000),
    ).toBeLessThanOrEqual(1);

    // A call whose provider reports no split keeps today's pricing.
    const { cacheWrite1h: _split, ...unsplit } = answer.usage;
    await recordFlueUsage(
      turnObservation("turn-unsplit", occurredAt, unsplit),
      { env } as unknown as FlueEventContext,
    );
    const legacy = await ledgerRow("turn-unsplit");
    assert.exists(legacy);
    expect(legacy.cache_write_1h_tokens).toBeNull();
    const rates = model.cost;
    expect(legacy.cost).toBe(
      Math.round(
        unsplit.input * rates.input +
          unsplit.output * rates.output +
          unsplit.cacheRead * rates.cacheRead +
          unsplit.cacheWrite * rates.cacheWrite,
      ),
    );
  }, 30_000);
});
