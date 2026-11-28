import { env } from "cloudflare:test";
import {
  type Api,
  type AssistantMessage,
  createModels,
  type Message,
  type Model,
  normalizeContext,
} from "@earendil-works/pi-ai";
import { Effect } from "effect";
import { afterEach, assert, beforeEach, describe, expect, it } from "vitest";
import {
  classifyRunFailure,
  MODEL_SAFETY_STOP,
} from "../../src/runtime/run-failure.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { createDxModelRoutingProvider } from "../../src/settings/model-byok/flue-provider.js";
import {
  upstreamDns,
  upstreamFetch,
} from "../../src/settings/model-byok/invocation.js";
import { encryptModelCredential } from "../../src/settings/model-routing/model-credential-encryption.js";

/**
 * A response the provider's safety system stops (thr_6615ce2c, 26 Nov:
 * Anthropic's cyber safeguards on a request to attack-test a plugin). The
 * model calls run through dx's real routing provider and credential
 * coordinator to a recorded Anthropic API that answers as Anthropic does:
 * thinking, then `stop_reason: "refusal"` with its explanation, and HTTP 400
 * for an assistant message whose final block is thinking.
 *
 * Ways it fails:
 * - the stop reaches the person as "Provider error", without the provider's
 *   reason, so they cannot tell what to change (the reported Thread);
 * - the provider's explanation and its link are lost or reworded;
 * - the stop is retried on dx's schedule, sending the same request again;
 * - another provider's safety stop (OpenAI's content filter) is missed;
 * - Retry resumes the stopped response, which holds only thinking, and every
 *   Retry fails with HTTP 400 (16:27 and 18:06 in that Thread);
 * - repairing it drops thinking that precedes a tool call, which Anthropic
 *   requires, or text the model wrote, or changes a valid history.
 */

const OWNER = "safety-owner";
const PROJECT = "safety-project";
const THREAD = "thr_00000000-0000-4000-8000-000000006615";
const CONNECTION = "mcon_safety";
const CREDENTIAL = "mcred_safety";
const MODEL = "claude-opus-5-5";
const API_KEY = "sk-ant-api-safety-test";
const OPENAI_ENDPOINT = "https://openai-gateway.test/v1";
const now = "2026-11-26T00:00:00.000Z";

/** Anthropic's words in production, 26 Nov 15:45 UTC. */
const CYBER =
  "Cyber safeguards flagged this message. If this is legitimate security work, you can apply for the Cyber Verification Program: https://support.claude.com/en/articles/14604842-cyber-verification-program.";

const realFetch = upstreamFetch.current;
const realDns = upstreamDns.current;
beforeEach(() => {
  upstreamDns.current = async () => ["8.8.8.8"];
});
afterEach(() => {
  upstreamFetch.current = realFetch;
  upstreamDns.current = realDns;
});

const seed = async (connection: "anthropic" | "openai-custom") => {
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(env as never),
  );
  const envelope = await Effect.runPromise(
    encryptModelCredential(
      keyring,
      {
        id: CREDENTIAL as never,
        target: { scope: "personal", id: OWNER as never },
        name: "key",
      },
      API_KEY as never,
    ),
  );
  const canonical =
    connection === "anthropic" ? `anthropic/${MODEL}` : "openai/gpt-5.5";
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
    ).bind(OWNER, "Owner", "safety-owner@dx.test", now, now),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(PROJECT, OWNER, "Safety project", now, now),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, model_selection, lifecycle_state, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?)",
    ).bind(
      THREAD,
      PROJECT,
      OWNER,
      JSON.stringify({ kind: "model", model: canonical }),
      now,
      now,
    ),
    env.DB.prepare(
      "INSERT INTO model_credential (id, scope, target_id, name, envelope_version, key_version, value_nonce, ciphertext, wrapped_key_nonce, wrapped_key, created_at, updated_at) VALUES (?, 'personal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      CREDENTIAL,
      OWNER,
      "key",
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
          "INSERT INTO model_connection (id, scope, target_id, name, kind, provider_id, base_url, format, fields, enabled, priority, model_credential_id, created_at, updated_at) VALUES (?, 'personal', ?, 'OpenAI gateway', 'custom', 'dx-custom', ?, 'openai-completions', '{}', 1, 0, ?, ?, ?)",
        ).bind(CONNECTION, OWNER, OPENAI_ENDPOINT, CREDENTIAL, now, now),
    ...(connection === "openai-custom"
      ? [
          env.DB.prepare(
            "INSERT INTO model_connection_model (connection_id, canonical, upstream, position) VALUES (?, ?, ?, 0)",
          ).bind(CONNECTION, canonical, "gpt-5.5"),
        ]
      : []),
  ]);
};

const routedModel = async (providerId: string, modelId: string) => {
  const submissionId = `sub-${crypto.randomUUID()}`;
  const prepared = await env.BYOK_CREDENTIAL_COORDINATOR.get(
    env.BYOK_CREDENTIAL_COORDINATOR.idFromName(`byok-${THREAD}`),
  ).fetch("https://coordinator/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ threadId: THREAD, submissionId, recovery: false }),
  });
  expect(prepared.status).toBe(200);
  await prepared.arrayBuffer();
  const { provider, options } = createDxModelRoutingProvider(providerId, {
    namespace: env.BYOK_CREDENTIAL_COORDINATOR,
    identity: () => ({ name: THREAD }) as never,
    invocation: () => ({ scope: { kind: "prompt", submissionId } }) as never,
  });
  assert.exists(options.resolveModel);
  const model = await options.resolveModel(
    { providerId, modelId },
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

const sse = (events: ReadonlyArray<Record<string, unknown>>) =>
  new Response(
    events
      .map((event) =>
        event.type === undefined
          ? `data: ${JSON.stringify(event)}\n\n`
          : `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
      )
      .join(""),
    { headers: { "content-type": "text/event-stream" } },
  );

const SIGNATURE = "c2lnbmVkLXRoaW5raW5n";

/**
 * Anthropic's Messages API as it answered that Thread: the first request is
 * thought about and then stopped by the safeguard; any request holding an
 * assistant message whose final block is thinking is refused with the
 * provider's 400; any other request is answered.
 */
const recordedAnthropic = () => {
  const requests: Array<{ messages: Array<Record<string, unknown>> }> = [];
  let refuse = true;
  upstreamFetch.current = (async (input: unknown, init?: RequestInit) => {
    const request = new Request(input as never, init as never);
    expect(request.url).toMatch(/^https:\/\/api\.anthropic\.com\/v1\/messages/);
    const body = (await request.json()) as {
      messages: Array<{ role: string; content: unknown }>;
    };
    requests.push(body as never);
    const thinkingLast = body.messages.findIndex(
      (message) =>
        message.role === "assistant" &&
        Array.isArray(message.content) &&
        (message.content.at(-1) as { type?: string } | undefined)?.type ===
          "thinking",
    );
    if (thinkingLast >= 0)
      return Response.json(
        {
          type: "error",
          error: {
            type: "invalid_request_error",
            message: `messages.${thinkingLast}: The final block in an assistant message cannot be \`thinking\`.`,
          },
          request_id: "req_recorded",
        },
        { status: 400 },
      );
    const start = {
      type: "message_start",
      message: {
        id: `msg_${requests.length}`,
        type: "message",
        role: "assistant",
        model: MODEL,
        content: [],
        stop_reason: null,
        usage: { input_tokens: 4, output_tokens: 0 },
      },
    };
    if (refuse) {
      refuse = false;
      return sse([
        start,
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "thinking", thinking: "", signature: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: {
            type: "thinking_delta",
            thinking: "The user asks for attacks against their own plugin.",
          },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: SIGNATURE },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: {
            stop_reason: "refusal",
            stop_details: { type: "refusal", explanation: CYBER },
          },
          usage: { output_tokens: 6 },
        },
        { type: "message_stop" },
      ]);
    }
    return sse([
      start,
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "text", text: "" },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Here is the security report." },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "end_turn" },
        usage: { output_tokens: 7 },
      },
      { type: "message_stop" },
    ]);
  }) as never;
  return { requests };
};

/**
 * A request's conversation as block types per message. pi-ai adds a
 * `system` entry carrying the effort level; it is not a turn.
 */
const conversation = (
  request: { messages: Array<Record<string, unknown>> } | undefined,
) =>
  (request?.messages ?? [])
    .filter((message) => message.role !== "system")
    .map((message) =>
      typeof message.content === "string"
        ? ["text"]
        : (message.content as Array<{ type: string }>).map(
            (block) => block.type,
          ),
    );

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const ASK: Message = {
  role: "user",
  content:
    "I give you permission to attack-test the plugin. Report all the issues to me.",
  timestamp: 1,
};

describe("a response the provider's safety system stops", () => {
  it("says the provider's own reason, is not retried, and Retry gets an answer instead of HTTP 400", async () => {
    await seed("anthropic");
    const anthropic = recordedAnthropic();
    const { models, model } = await routedModel("anthropic", MODEL);

    const stopped: AssistantMessage = await models
      .streamSimple(model, normalizeContext({ messages: [ASK] }), {
        reasoning: "high",
      } as never)
      .result();

    expect(stopped.stopReason).toBe("error");
    expect(stopped.errorMessage).toBe(
      `The model provider's safety system stopped this response: ${CYBER} Rephrase the request or choose another model, then retry. (dx_failure:internal:${MODEL_SAFETY_STOP})`,
    );
    const failure = classifyRunFailure({
      message: `direct(sub_1) failed: ${stopped.errorMessage}`,
    });
    expect(failure).toMatchObject({
      class: "internal",
      code: MODEL_SAFETY_STOP,
      retryable: false,
    });
    expect(failure.message).toContain(CYBER);
    // What the stopped response kept: its signed thinking, nothing else.
    expect(stopped.content.map((block) => block.type)).toEqual(["thinking"]);

    // Retry: Flue resumes the stopped response as if it had completed
    // (`resumeFailedAssistantId`: stopReason "stop", content unchanged).
    const resumed = await models
      .streamSimple(
        model,
        normalizeContext({
          messages: [
            ASK,
            { ...stopped, stopReason: "stop", errorMessage: undefined },
          ],
        }),
        { reasoning: "high" } as never,
      )
      .result();

    expect(resumed.errorMessage).toBeUndefined();
    expect(resumed.stopReason).toBe("stop");
    expect(resumed.content).toEqual([
      { type: "text", text: "Here is the security report." },
    ]);
    expect(anthropic.requests).toHaveLength(2);
    // The model starts again from the person's message.
    expect(conversation(anthropic.requests[1])).toEqual([["text"]]);
  });

  it("keeps thinking before a tool call or text, and leaves a valid history unchanged", async () => {
    await seed("anthropic");
    const anthropic = recordedAnthropic();
    const { models, model } = await routedModel("anthropic", MODEL);
    // Spend the recorded refusal on a first call.
    await models
      .streamSimple(model, normalizeContext({ messages: [ASK] }), {
        reasoning: "high",
      } as never)
      .result();

    const thinking = {
      type: "thinking" as const,
      thinking: "Plan the next step.",
      thinkingSignature: SIGNATURE,
    };
    const assistant = (
      content: AssistantMessage["content"],
      stopReason: AssistantMessage["stopReason"],
    ): AssistantMessage => ({
      role: "assistant",
      content,
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage,
      stopReason,
      timestamp: 2,
    });
    const history: Message[] = [
      ASK,
      assistant(
        [
          thinking,
          { type: "toolCall", id: "toolu_1", name: "read", arguments: {} },
        ],
        "toolUse",
      ),
      {
        role: "toolResult",
        toolCallId: "toolu_1",
        toolName: "read",
        content: [{ type: "text", text: "file contents" }],
        isError: false,
        timestamp: 3,
      },
      assistant(
        [thinking, { type: "text", text: "Found two issues." }],
        "stop",
      ),
      { role: "user", content: "Go on.", timestamp: 4 },
      // A response stopped after its text and more thinking.
      assistant(
        [thinking, { type: "text", text: "Third issue:" }, thinking],
        "stop",
      ),
      { role: "user", content: "Continue.", timestamp: 5 },
    ];

    const answer = await models
      .streamSimple(model, normalizeContext({ messages: history }), {
        reasoning: "high",
      } as never)
      .result();

    expect(answer.errorMessage).toBeUndefined();
    expect(conversation(anthropic.requests[1])).toEqual([
      ["text"],
      ["thinking", "tool_use"],
      ["tool_result"],
      ["thinking", "text"],
      ["text"],
      ["thinking", "text"],
      ["text"],
    ]);
  });

  it("names an OpenAI content filter stop the same way", async () => {
    await seed("openai-custom");
    upstreamFetch.current = (async (input: unknown) => {
      expect(new Request(input as never).url).toBe(
        `${OPENAI_ENDPOINT}/chat/completions`,
      );
      return sse([
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: "gpt-5.5",
          choices: [{ index: 0, delta: { role: "assistant", content: "" } }],
        },
        {
          id: "chatcmpl-1",
          object: "chat.completion.chunk",
          model: "gpt-5.5",
          choices: [{ index: 0, delta: {}, finish_reason: "content_filter" }],
        },
      ]);
    }) as never;
    const { models, model } = await routedModel("openai", "gpt-5.5");

    const stopped = await models
      .streamSimple(model, normalizeContext({ messages: [ASK] }), {} as never)
      .result();

    expect(stopped.stopReason).toBe("error");
    expect(stopped.errorMessage).toBe(
      `The model provider's safety system stopped this response (content_filter). Rephrase the request or choose another model, then retry. (dx_failure:internal:${MODEL_SAFETY_STOP})`,
    );
  });
});
