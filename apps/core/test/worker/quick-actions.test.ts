import { env } from "cloudflare:test";
import type { Principal, ThreadId } from "@dx/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  claudeCodeModePrompt,
  dxAgentPrompt,
} from "../../src/agents/dx-agent-prompt.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { createOwnerAskTools } from "../../src/owner-asks/agent-tools.js";
import {
  type QuickActionsCaller,
  workersAiQuickActions,
} from "../../src/quick-actions/actions.js";
import {
  type ReplyWriter,
  workersAiReplyWriter,
} from "../../src/quick-actions/reply-writer.js";
import { threadQuickActionsRoutes } from "../../src/quick-actions/routes.js";
import { pickQuickActionsAtTurnEnd } from "../../src/quick-actions/turn-ended.js";
import type {
  HistoryMessage,
  HistoryRead,
  SettlementOutcome,
} from "../../src/thread-search/history.js";
import {
  bindings,
  createProjectViaApi,
  createThreadViaApi,
  otherPrincipal,
  principal,
} from "./product-route-fixture.js";

/**
 * Composer quick actions in workerd with real D1: the turn-end hook picks,
 * the route serves. The reply writer, the Clef call, and Flue's history
 * read are replaced; the fakes record what they were sent. The ways it
 * could fail:
 *
 * 1. The agent is told about quick actions: a tool or a prompt line.
 * 2. The hook calls Clef, or stores a pick, when the deployment has no
 *    Workers AI, or the turn failed or was stopped.
 * 3. It picks for a message that did not end the turn: a newer message, or
 *    a response from another submission.
 * 4. The writer reads anything but the agent's final reply (text before
 *    its last tool call), or its untrusted answer reaches a chip unchecked:
 *    non-strings, several lines, too long, repeated, more than six, or
 *    JSON wrapped in prose. A failed writer shows a guess.
 * 5. Clef's answer is trusted: an out-of-range or mistyped score, or one for
 *    a question dx did not ask, places an action; a "do not offer" score
 *    shows one; the order ignores Clef's scores; more than two replies show;
 *    a failed call shows a guess, or leaves the page waiting.
 * 6. A turn that settles several submissions asks Clef more than once.
 * 7. The route asks a model itself, serves a pick for another message, or
 *    answers without Workers AI, or to a viewer.
 * 8. Snooze is offered to a contributor, or for a Thread already snoozed.
 * 9. Another model than GLM 4.7 Flash writes, or than Clef Flash ranks.
 */

const withAi = (run: (model: string, input: unknown) => unknown): Bindings =>
  ({
    ...bindings,
    AI: { run: async (model: string, input: unknown) => run(model, input) },
  }) as unknown as Bindings;

const fakeClef = () => {
  const calls: Array<{
    state: { lastAgentMessage?: string; actions?: unknown[] };
    questions: string[];
  }> = [];
  let answers: Record<string, unknown> | undefined;
  const call: QuickActionsCaller = async ({ state, questions }) => {
    calls.push({
      state: state as (typeof calls)[number]["state"],
      questions: Object.keys(questions),
    });
    return answers === undefined ? { ok: false } : { ok: true, answers };
  };
  return {
    calls,
    call,
    answer: (next: Record<string, unknown> | undefined) => {
      answers = next;
    },
  };
};

const fakeWriter = () => {
  const messages: string[] = [];
  let replies: ReadonlyArray<string> = [];
  const write: ReplyWriter = async ({ message }) => {
    messages.push(message);
    return replies;
  };
  return {
    messages,
    write,
    answer: (next: ReadonlyArray<string>) => {
      replies = next;
    },
  };
};

const score = (value: unknown) => ({ type: "score", score: value });
const text = (value: string) => ({ type: "text", text: value });
const tool = (name: string) => ({
  type: "dynamic-tool",
  toolName: name,
  toolCallId: `call-${name}`,
  state: "output-available",
  input: {},
});

const message = (
  id: string,
  role: "user" | "assistant",
  parts: HistoryMessage["parts"],
  submissionId = `sub-${id}`,
): HistoryMessage => ({ id, role, purpose: role, submissionId, parts });

const history = (
  messages: ReadonlyArray<HistoryMessage>,
  settled: Record<string, SettlementOutcome> = {},
  answeredBy: Record<string, string> = {},
): HistoryRead => ({
  kind: "page",
  page: {
    messages,
    settled: new Map(Object.entries(settled)),
    failures: new Map(),
    answeredBy: new Map(Object.entries(answeredBy)),
    hasOlder: false,
  },
});

/** The route behind what `authorizeThread` would set for `access`. */
const appFor = (who: Principal, access: "owner" | "contribute" | "view") => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", who);
    context.set("actor", who);
    context.set("threadAccess", access);
    context.set("threadOwnerUserId", principal.userId);
    await next();
  });
  app.route("/threads", threadQuickActionsRoutes);
  return app;
};

const get = async (
  app: Hono<AppEnv>,
  threadId: string,
  on: Bindings,
  messageId?: string,
) => {
  const response = await app.request(
    `/threads/${threadId}/quick-actions${
      messageId === undefined ? "" : `?messageId=${messageId}`
    }`,
    {},
    on,
  );
  return {
    status: response.status,
    body: (await response.json()) as {
      data: {
        code?: string;
        messageId?: string;
        actions?: unknown[];
        pending?: boolean;
      };
    },
  };
};

const stored = (threadId: string) =>
  env.DB.prepare(
    "SELECT message_id, actions FROM thread_quick_actions WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<{ message_id: string; actions: string }>();

const ENDING =
  "I added the cache and the tests pass.\n\nWant me to open a PR, or keep iterating on the cache first?";

describe("Composer quick actions", () => {
  it("never tells the agent: no tool, no prompt line", () => {
    const tools = createOwnerAskTools("thr_x", () => {
      throw new Error("not called");
    });
    expect(tools.map(({ name }) => name)).toEqual(["request_attention"]);
    for (const prompt of [dxAgentPrompt, claudeCodeModePrompt])
      expect(prompt).not.toMatch(/offer_replies|quick action|reply chip/i);
  });

  it("picks at turn end from the replies the writer wrote, and the route serves only that pick", async () => {
    const project = await createProjectViaApi("quick-actions");
    const thread = (await createThreadViaApi(project.data.id)).data
      .id as ThreadId;
    const clef = fakeClef();
    const writer = fakeWriter();
    writer.answer(["Open a PR", "Keep iterating on the cache first"]);
    let current = history(
      [
        message("u1", "user", [text("Add a cache.")]),
        message("a1", "assistant", [
          text("Should I use Redis or memcached?"),
          tool("bash"),
          text(ENDING),
        ]),
      ],
      { "sub-a1": "completed" },
    );
    const read = async () => current;
    const ai = withAi(() => ({}));
    const settle = (
      submissionId: string,
      outcome: SettlementOutcome = "completed",
      on: Bindings = ai,
    ) =>
      pickQuickActionsAtTurnEnd(
        on,
        { threadId: thread, submissionId, outcome },
        clef.call,
        read,
        writer.write,
      );
    const owner = appFor(principal, "owner");

    // 2. No Workers AI, or a failed or stopped turn: no call.
    const { AI: _ai, ...withoutAi } = bindings;
    await settle("sub-a1", "completed", withoutAi as Bindings);
    await settle("sub-a1", "completed", {
      ...ai,
      DX_MODEL_WORKERS_AI_ENABLED: "false",
    } as Bindings);
    await settle("sub-a1", "failed");
    await settle("sub-a1", "aborted");
    expect(clef.calls).toEqual([]);
    expect(writer.messages).toEqual([]);
    expect(await stored(thread)).toBeNull();

    // 7. Before the hook picks, the route says pending, and asks no model.
    expect((await get(owner, thread, ai, "a1")).body.data).toEqual({
      actions: [],
      pending: true,
    });

    // 4, 5. The writer reads only the final reply, after the last tool
    // call; Clef ranks what it wrote, and 0 hides one.
    clef.answer({
      "a1.fit": score(2),
      "a2.fit": score(0),
      "a3.fit": score(3),
      "a9.fit": score(3),
    });
    await settle("sub-a1");
    expect(writer.messages).toEqual([ENDING]);
    expect(clef.calls).toHaveLength(1);
    expect(clef.calls[0]?.questions).toEqual(["a1.fit", "a2.fit", "a3.fit"]);
    expect(clef.calls[0]?.state).toMatchObject({
      lastAgentMessage:
        "I added the cache and the tests pass. Want me to open a PR, or keep iterating on the cache first?",
      actions: [
        { action: "a1", kind: "reply", sends: "Open a PR" },
        {
          action: "a2",
          kind: "reply",
          sends: "Keep iterating on the cache first",
        },
        { action: "a3", kind: "snooze" },
      ],
    });
    expect(JSON.stringify(clef.calls)).not.toMatch(/Redis|memcached/);
    const picked = {
      messageId: "a1",
      actions: [{ kind: "snooze" }, { kind: "reply", text: "Open a PR" }],
    };
    expect((await get(owner, thread, ai, "a1")).body.data).toEqual(picked);
    expect((await get(owner, thread, ai)).body.data).toEqual(picked);

    // 6. Another submission that settled with the same turn asks no more.
    current = history(
      [
        message("u1", "user", [text("Add a cache.")]),
        message("u2", "user", [text("Also log it.")], "sub-u2"),
        message("a1", "assistant", [text(ENDING)]),
      ],
      { "sub-a1": "completed", "sub-u2": "completed" },
      { "sub-u2": "sub-a1" },
    );
    await settle("sub-u2");
    expect(clef.calls).toHaveLength(1);
    expect(writer.messages).toHaveLength(1);

    // 7, 8. A contributor gets the replies without Snooze; a message the
    // hook has not picked for is pending; viewers, or anyone without
    // Workers AI, get nothing.
    const contributor = appFor(otherPrincipal, "contribute");
    expect((await get(contributor, thread, ai, "a1")).body.data).toEqual({
      messageId: "a1",
      actions: [{ kind: "reply", text: "Open a PR" }],
    });
    expect((await get(contributor, thread, ai, "made-up")).body.data).toEqual({
      actions: [],
      pending: true,
    });
    const viewed = await get(appFor(otherPrincipal, "view"), thread, ai, "a1");
    expect([viewed.status, viewed.body.data.code]).toEqual([
      403,
      "QUICK_ACTIONS_READ_ONLY",
    ]);
    const noAi = await get(owner, thread, withoutAi as Bindings, "a1");
    expect([noAi.status, noAi.body.data.code]).toEqual([
      409,
      "QUICK_ACTIONS_MODEL_UNAVAILABLE",
    ]);
    await env.DB.prepare("UPDATE threads SET snoozed_until = ? WHERE id = ?")
      .bind(new Date(Date.now() + 3_600_000).toISOString(), thread)
      .run();
    expect((await get(owner, thread, ai, "a1")).body.data.actions).toEqual([
      { kind: "reply", text: "Open a PR" },
    ]);
    await env.DB.prepare("UPDATE threads SET snoozed_until = NULL WHERE id = ?")
      .bind(thread)
      .run();

    // 5. Mistyped and out-of-range scores place nothing; at most two
    // replies show, the likeliest.
    current = history(
      [
        message("a2", "assistant", [
          text(
            "Pick one:\n\n- **Python**\n- **Go**\n- **Rust**\n- **Zig**\n\nWhich do you prefer?",
          ),
        ]),
      ],
      { "sub-a2": "completed" },
    );
    writer.answer(["Python", "Go", "Rust", "Zig"]);
    clef.answer({
      "a1.fit": score(1),
      "a2.fit": score(3),
      "a3.fit": score(2),
      "a4.fit": score(7),
      "a5.fit": { type: "choice", score: 2 },
    });
    await settle("sub-a2");
    expect(clef.calls.at(-1)?.state.actions).toMatchObject([
      { sends: "Python" },
      { sends: "Go" },
      { sends: "Rust" },
      { sends: "Zig" },
      { kind: "snooze" },
    ]);
    expect((await get(owner, thread, ai, "a2")).body.data.actions).toEqual([
      { kind: "reply", text: "Go" },
      { kind: "reply", text: "Rust" },
    ]);

    // 4. A writer that offers nothing leaves Snooze the only candidate.
    current = history([message("a2b", "assistant", [text("All done.")])], {
      "sub-a2b": "completed",
    });
    writer.answer([]);
    clef.answer({ "a1.fit": score(3) });
    await settle("sub-a2b");
    expect(clef.calls.at(-1)?.state.actions).toMatchObject([
      { kind: "snooze" },
    ]);
    expect((await get(owner, thread, ai, "a2b")).body.data.actions).toEqual([
      { kind: "snooze" },
    ]);

    // 5. A failed call stores an empty pick: the row settles on nothing
    // instead of waiting, and shows no guess.
    current = history([message("a3", "assistant", [text(ENDING)])], {
      "sub-a3": "completed",
    });
    writer.answer(["Open a PR"]);
    clef.answer(undefined);
    await settle("sub-a3");
    expect((await get(owner, thread, ai, "a3")).body.data).toEqual({
      messageId: "a3",
      actions: [],
    });

    // 3. A newer message, or a response from another submission, ended
    // nothing: no call, and the stored pick stays the last turn's.
    const calls = clef.calls.length;
    current = history(
      [
        message("a4", "assistant", [text(ENDING)]),
        message("u4", "user", [text("Wait")]),
      ],
      { "sub-a4": "completed" },
    );
    await settle("sub-a4");
    current = history([message("a5", "assistant", [text(ENDING)])], {
      "sub-a5": "completed",
    });
    await settle("sub-other");
    expect(clef.calls).toHaveLength(calls);
    expect((await stored(thread))?.message_id).toBe("a3");
  });

  it("writes replies with GLM 4.7 Flash and keeps only ones a chip can send", async () => {
    const runs: Array<{ model: string; input: unknown }> = [];
    let answer: unknown;
    const on = withAi((model, input) => {
      runs.push({ model, input });
      if (answer instanceof Error) throw answer;
      return answer;
    });
    const write = (message: string) =>
      workersAiReplyWriter({ bindings: on, message });
    const reply = (content: unknown) => ({
      choices: [{ message: { role: "assistant", content } }],
    });

    // 9. One call to GLM 4.7 Flash, the message as data at the end of the
    // prompt, asking for JSON.
    answer = reply('{"replies": ["Yes, add a test for it", "Not now"]}');
    expect(
      await write("Done. Would you like me to add a test for it?"),
    ).toEqual(["Yes, add a test for it", "Not now"]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.model).toBe("@cf/zai-org/glm-4.7-flash");
    expect(runs[0]?.input).toMatchObject({
      messages: [
        { role: "system" },
        {
          role: "user",
          content:
            "<agent_message>\nDone. Would you like me to add a test for it?\n</agent_message>",
        },
      ],
      response_format: { type: "json_schema" },
      chat_template_kwargs: { enable_thinking: false },
    });

    // 4. Its answer is untrusted: only short one-line strings, once each,
    // at most six; JSON wrapped in prose or a fence still reads.
    answer = reply(
      `Sure!\n\`\`\`json\n${JSON.stringify({
        replies: [
          " Go ",
          "go",
          42,
          null,
          "Two\nlines",
          "x".repeat(121),
          "",
          "A",
          "B",
          "C",
          "D",
          "E",
          "F",
        ],
      })}\n\`\`\``,
    );
    expect(await write("Python or Go?")).toEqual([
      "Go",
      "A",
      "B",
      "C",
      "D",
      "E",
    ]);
    answer = { response: { replies: ["Ship it now.", "Wait..."] } };
    expect(await write("Ship it?")).toEqual(["Ship it now", "Wait..."]);

    // 4. Prose, a wrong shape, an error, or an empty message: no replies.
    for (const next of [
      reply("I think you should say yes."),
      reply('{"replies": "Yes"}'),
      reply("{not json}"),
      {},
      new Error("Workers AI is down"),
    ]) {
      answer = next;
      expect(await write("Ship it?")).toEqual([]);
    }
    const before = runs.length;
    expect(await write("   ")).toEqual([]);
    expect(runs).toHaveLength(before);
  });

  it("calls only Clef Flash on Workers AI", async () => {
    const runs: Array<{ model: string; input: unknown }> = [];
    const result = await workersAiQuickActions({
      bindings: withAi((model, input) => {
        runs.push({ model, input });
        return { answers: { "a1.fit": score(2) } };
      }),
      state: { actions: [] },
      questions: { "a1.fit": {} },
    });
    expect(result).toEqual({ ok: true, answers: { "a1.fit": score(2) } });
    expect(runs).toEqual([
      {
        model: "@cf/cloudflare/clef-flash",
        input: {
          model: "clef-flash",
          state: { actions: [] },
          questions: { "a1.fit": {} },
        },
      },
    ]);
    expect(
      await workersAiQuickActions({
        bindings: withAi(() => {
          throw new Error("Workers AI is down");
        }),
        state: {},
        questions: {},
      }),
    ).toEqual({ ok: false });
  });
});
