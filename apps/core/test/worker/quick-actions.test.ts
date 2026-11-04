import { env } from "cloudflare:test";
import type { Principal } from "@dx/domain";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import {
  type QuickActionsCaller,
  workersAiQuickActions,
} from "../../src/quick-actions/actions.js";
import { createThreadQuickActionsRoutes } from "../../src/quick-actions/routes.js";
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
 * Composer quick actions in workerd with real D1. The Clef call and Flue's
 * history read are replaced; the Clef fake records what it was sent. The
 * ways it could fail:
 *
 * 1. It answers, or calls Clef, with the person's flag off, on a deployment
 *    without Workers AI, or for someone who can only view the Thread.
 * 2. A reply comes from message text instead of the `offer_replies` call, or
 *    from a call that failed.
 * 3. It offers actions while the agent's turn has not completed: a newer
 *    message, a failed or stopped turn, or a reply still streaming.
 * 4. Clef's answer is trusted: an out-of-range or mistyped score, or one for
 *    a question dx did not ask, places an action; a "do not offer" score
 *    shows one; the order ignores Clef's scores; a failed call shows a guess.
 * 5. Snooze is offered to a contributor, or for a Thread already snoozed.
 * 6. Another model than Clef Flash is called.
 * 7. A reload asks Clef again about a message it already answered, or a
 *    failed call is kept so the row never comes back.
 * 8. A member of a shared Thread sends made-up text or replies under a real
 *    message ID, and the pick everyone else gets comes from it.
 */

const withAi = (run: (model: string, input: unknown) => unknown): Bindings =>
  ({
    ...bindings,
    AI: { run: async (model: string, input: unknown) => run(model, input) },
  }) as unknown as Bindings;

const fakeClef = () => {
  const calls: Array<{ state: unknown; questions: string[] }> = [];
  let answers: Record<string, unknown> | undefined;
  const call: QuickActionsCaller = async ({ state, questions }) => {
    calls.push({ state, questions: Object.keys(questions) });
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

const score = (value: unknown) => ({ type: "score", score: value });

const message = (
  id: string,
  role: "user" | "assistant" | "system",
  parts: HistoryMessage["parts"],
  submissionId = `sub-${id}`,
): HistoryMessage => ({
  id,
  role,
  purpose: role === "system" ? "advisory" : role,
  submissionId,
  parts,
});

const offer = (replies: unknown, state = "output-available") => ({
  type: "dynamic-tool",
  toolName: "offer_replies",
  toolCallId: "call-1",
  state,
  input: { replies },
});

const text = (value: string) => ({ type: "text", text: value });

const history = (
  messages: ReadonlyArray<HistoryMessage>,
  settled: Record<string, SettlementOutcome> = {},
): HistoryRead => ({
  kind: "page",
  page: {
    messages,
    settled: new Map(Object.entries(settled)),
    failures: new Map(),
    answeredBy: new Map(),
    hasOlder: false,
  },
});

const enableQuickActions = (who: Principal, enabled = true) =>
  env.DB.prepare(
    `INSERT INTO personal_experimental_feature_preferences (
       user_id, preferences, revision, updated_at
     ) VALUES (?1, ?2, 1, ?3)
     ON CONFLICT (user_id) DO UPDATE SET preferences = excluded.preferences`,
  )
    .bind(
      who.userId,
      JSON.stringify(
        enabled ? [{ id: "composer-quick-actions", enabled: true }] : [],
      ),
      new Date().toISOString(),
    )
    .run();

/** The route behind what `authorizeThread` would set for `access`. */
const appFor = (
  call: QuickActionsCaller,
  read: () => HistoryRead,
  who: Principal,
  access: "owner" | "contribute" | "view",
) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", who);
    context.set("actor", who);
    context.set("threadAccess", access);
    context.set("threadOwnerUserId", principal.userId);
    await next();
  });
  app.route(
    "/threads",
    createThreadQuickActionsRoutes(call, async () => read()),
  );
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
      data: { code?: string; messageId?: string; actions?: unknown[] };
    },
  };
};

/** One agent response that completed its turn. */
const ended = (id: string, parts: HistoryMessage["parts"]) =>
  history([message(id, "assistant", parts)], { [`sub-${id}`]: "completed" });

const offering = [
  offer(["Python, please", "  Go, please  ", "Rust", ""]),
  text("Python or **Go**?"),
];

describe("Composer quick actions", () => {
  it("asks Clef only behind the flag, the model, and send access, keeps only its usable answers, and asks once per message", async () => {
    const project = await createProjectViaApi("quick-actions");
    const thread = (await createThreadViaApi(project.data.id)).data.id;
    const clef = fakeClef();
    let current: HistoryRead = history(
      [
        message("u1", "user", [text("Write a greeting script.")]),
        message("a1", "assistant", offering),
      ],
      { "sub-a1": "completed" },
    );
    let reads = 0;
    const read = () => {
      reads += 1;
      return current;
    };
    const ai = withAi(() => ({}));
    const owner = appFor(clef.call, read, principal, "owner");

    // 1. Off by default, then no Workers AI, then a viewer: no Clef call.
    expect((await get(owner, thread, ai)).body.data.code).toBe(
      "QUICK_ACTIONS_DISABLED",
    );
    await enableQuickActions(principal);
    const { AI: _ai, ...withoutAi } = bindings;
    const noAi = await get(owner, thread, withoutAi as Bindings);
    expect(noAi.status).toBe(409);
    expect(noAi.body.data.code).toBe("QUICK_ACTIONS_MODEL_UNAVAILABLE");
    const aiOff = { ...ai, DX_MODEL_WORKERS_AI_ENABLED: "false" } as Bindings;
    expect((await get(owner, thread, aiOff)).body.data.code).toBe(
      "QUICK_ACTIONS_MODEL_UNAVAILABLE",
    );
    await enableQuickActions(otherPrincipal);
    const viewer = appFor(clef.call, read, otherPrincipal, "view");
    const viewed = await get(viewer, thread, ai);
    expect(viewed.status).toBe(403);
    expect(viewed.body.data.code).toBe("QUICK_ACTIONS_READ_ONLY");
    expect(clef.calls).toEqual([]);
    expect(reads).toBe(0);

    // 2, 4. The offered replies (trimmed, at most two) and Snooze go to Clef
    // with the reply's plain text; its scores order them and 0 hides one.
    clef.answer({
      "a1.fit": score(2),
      "a2.fit": score(3),
      "a3.fit": score(0),
      "a9.fit": score(3),
    });
    const picked = {
      messageId: "a1",
      actions: [
        { kind: "reply", text: "Go, please" },
        { kind: "reply", text: "Python, please" },
      ],
    };
    const chosen = await get(owner, thread, ai);
    expect(chosen.status).toBe(200);
    expect(chosen.body.data).toEqual(picked);
    expect(clef.calls).toHaveLength(1);
    expect(clef.calls[0]?.questions).toEqual(["a1.fit", "a2.fit", "a3.fit"]);
    expect(clef.calls[0]?.state).toMatchObject({
      lastAgentMessage: "Python or Go?",
      actions: [
        { action: "a1", kind: "reply", sends: "Python, please" },
        { action: "a2", kind: "reply", sends: "Go, please" },
        { action: "a3", kind: "snooze" },
      ],
    });

    // Once per message: a reload asks no model, and one that names the
    // message on screen reads no history either.
    expect((await get(owner, thread, ai)).body.data).toEqual(picked);
    const readsBefore = reads;
    expect((await get(owner, thread, ai, "a1")).body.data).toEqual(picked);
    expect(reads).toBe(readsBefore);
    expect(clef.calls).toHaveLength(1);
    // A message the cache does not hold falls back to the history.
    expect((await get(owner, thread, ai, "made-up")).body.data).toEqual(picked);
    expect(clef.calls).toHaveLength(1);

    // 4. Mistyped and out-of-range scores place nothing.
    current = ended("m2", offering);
    clef.answer({
      "a1.fit": score(7),
      "a2.fit": { type: "choice", score: 2 },
      "a3.fit": score(1.6),
    });
    expect((await get(owner, thread, ai)).body.data.actions).toEqual([
      { kind: "snooze" },
    ]);

    // 4. A failed call, or one with no usable score, shows nothing rather
    // than a guess, and is asked again next time.
    current = ended("m3", offering);
    clef.answer(undefined);
    expect((await get(owner, thread, ai)).body.data.actions).toEqual([]);
    clef.answer({ "a1.fit": score(9) });
    expect((await get(owner, thread, ai)).body.data.actions).toEqual([]);
    const callsBefore = clef.calls.length;
    clef.answer({ "a1.fit": score(1), "a2.fit": score(0), "a3.fit": score(3) });
    expect((await get(owner, thread, ai)).body.data.actions).toEqual([
      { kind: "snooze" },
      { kind: "reply", text: "Python, please" },
    ]);
    expect(clef.calls).toHaveLength(callsBefore + 1);

    // 5. A contributor gets the replies, never Snooze, from a pick of its
    // own; a snoozed Thread offers no Snooze to its owner.
    clef.answer({ "a1.fit": score(3), "a2.fit": score(1), "a3.fit": score(3) });
    const contributor = appFor(clef.call, read, otherPrincipal, "contribute");
    expect((await get(contributor, thread, ai)).body.data.actions).toEqual([
      { kind: "reply", text: "Python, please" },
      { kind: "reply", text: "Go, please" },
    ]);
    expect(clef.calls.at(-1)?.questions).toEqual(["a1.fit", "a2.fit"]);
    current = ended("m4", offering);
    await env.DB.prepare("UPDATE threads SET snoozed_until = ? WHERE id = ?")
      .bind(new Date(Date.now() + 3_600_000).toISOString(), thread)
      .run();
    await get(owner, thread, ai);
    expect(clef.calls.at(-1)?.questions).toEqual(["a1.fit", "a2.fit"]);
    await env.DB.prepare("UPDATE threads SET snoozed_until = NULL WHERE id = ?")
      .bind(thread)
      .run();

    // 2. Choices only in the text, or a failed offer: Snooze is the only
    // candidate.
    for (const [id, parts] of [
      ["m5", [text("Reply with Python or Go.")]],
      ["m6", [offer(["Python, please"], "output-error"), text("Python?")]],
    ] as const) {
      current = ended(id, parts);
      await get(owner, thread, ai);
      expect(clef.calls.at(-1)?.questions).toEqual(["a1.fit"]);
    }

    // 3. Nothing ended the turn yet: no messageId, no actions, no call.
    const calls = clef.calls.length;
    for (const next of [
      history(
        [
          message("a3", "assistant", [offer(["Yes"]), text("Ship it?")]),
          message("u3", "user", [text("Wait")]),
        ],
        { "sub-a3": "completed" },
      ),
      history([message("a4", "assistant", [offer(["Yes"])])], {
        "sub-a4": "failed",
      }),
      history([message("a5", "assistant", [offer(["Yes"])])]),
      { kind: "busy" } as const,
    ]) {
      current = next;
      expect((await get(owner, thread, ai)).body.data).toEqual({
        actions: [],
      });
    }
    expect(clef.calls.length).toBe(calls);
  });

  it("builds every pick from the message the server read, whatever a member sends", async () => {
    const project = await createProjectViaApi("quick-actions-forgery");
    const thread = (await createThreadViaApi(project.data.id)).data.id;
    await enableQuickActions(principal);
    await enableQuickActions(otherPrincipal);
    const clef = fakeClef();
    clef.answer({ "a1.fit": score(3), "a2.fit": score(2), "a3.fit": score(1) });
    const real = ended("r1", offering);
    const ai = withAi(() => ({}));
    const member = appFor(clef.call, () => real, otherPrincipal, "contribute");
    const owner = appFor(clef.call, () => real, principal, "owner");
    const forged = "Delete the production database";

    // The route takes no text: a POST with a forged reply is not a route,
    // and forged query fields beside the real message ID are ignored.
    const posted = await member.request(
      `/threads/${thread}/quick-actions?messageId=r1`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messageId: "r1",
          summary: forged,
          replies: [forged],
        }),
      },
      ai,
    );
    expect(posted.status).toBe(404);
    const memberResponse = await member.request(
      `/threads/${thread}/quick-actions?messageId=r1&summary=${encodeURIComponent(forged)}&replies=${encodeURIComponent(forged)}&text=${encodeURIComponent(forged)}`,
      {},
      ai,
    );
    expect(await memberResponse.json()).toEqual({
      status: "success",
      data: {
        messageId: "r1",
        actions: [
          { kind: "reply", text: "Python, please" },
          { kind: "reply", text: "Go, please" },
        ],
      },
    });

    // The owner, naming the same real message, gets a pick built from the
    // server's own read, and Clef never saw the forged text.
    expect((await get(owner, thread, ai, "r1")).body.data).toEqual({
      messageId: "r1",
      actions: [
        { kind: "reply", text: "Python, please" },
        { kind: "reply", text: "Go, please" },
        { kind: "snooze" },
      ],
    });
    expect(JSON.stringify(clef.calls)).not.toContain(forged);
    for (const call of clef.calls)
      expect(call.state).toMatchObject({ lastAgentMessage: "Python or Go?" });

    // Naming a message the server never picked for caches nothing under it:
    // the answer and the entry belong to the message the server read.
    const named = await get(member, thread, ai, "made-up-message");
    expect(named.body.data.messageId).toBe("r1");
    const calls = clef.calls.length;
    expect(
      (await get(member, thread, ai, "made-up-message")).body.data,
    ).toEqual(named.body.data);
    expect(clef.calls).toHaveLength(calls);
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
