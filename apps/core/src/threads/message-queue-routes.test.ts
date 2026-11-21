// Editing and deleting messages through the queue routes, with Flue a stand-in
// that answers withdraw, the queue read, Stop, and rewind as it would.
//
// Ways it could go wrong: a waiting message is edited by stopping the agent
// (it should be replaced in the queue); the agent picking the message up
// between the read and the withdraw loses the edit or edits it without the
// edit mark; a delete the agent beat silently rewinds; someone else's message,
// chat, or a Space post is changed; a retry sends twice or rewinds again; a
// read delete resends anything, skips Stop, or leaves no mark for the next
// message.

import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../thread-search/index-client.js", () => ({
  ownerSearchIndex: () => ({ dropThread: async () => undefined }),
}));
vi.mock("../thread-search/enqueue.js", () => ({
  enqueueThreadSearchIndex: async () => undefined,
}));

import type {
  QueuedThreadMessage,
  ReplaceThreadMessageResult,
  WithdrawThreadMessageResult,
} from "../agents/routes.js";
import type { AppEnv, Bindings } from "../http/types.js";
import {
  createThreadMessageQueueRoutes,
  type MessageQueueAgent,
} from "./message-queue-routes.js";

const THREAD = "thr_00000000-0000-4000-8000-0000000000a1";
const VIEWER = "usr_viewer";
const tag = (userId: string, extra = "") =>
  `<dx_message_author role="owner" user_id="${userId}" identifier="Alex"${extra} />\n`;

interface Sent {
  readonly body: string;
  readonly idempotencyKey: string;
  readonly edit: boolean;
}

const harness = (options: {
  queue?: QueuedThreadMessage[];
  /** What Flue's withdraw answers for each call, in order. */
  withdraws?: WithdrawThreadMessageResult[];
  /** What Flue's replace answers for each call, in order. */
  replaces?: ReplaceThreadMessageResult[];
  /** What Flue's rewind answers for each call, in order. */
  rewinds?: number[];
  threadKind?: "space";
  archived?: boolean;
}) => {
  const queue = [...(options.queue ?? [])];
  const withdraws = [...(options.withdraws ?? [])];
  const replaces = [...(options.replaces ?? [])];
  const replaced: Array<{ expectBody: string; body: string }> = [];
  const rewinds = [...(options.rewinds ?? [])];
  const calls: string[] = [];
  const sent: Sent[] = [];
  const rewound: Array<{ entryId: string; expectText: string; key: string }> =
    [];
  const agentRoutes = new Hono<AppEnv>().post("/:threadId", async (context) => {
    const body = (await context.req.json()) as {
      body: string;
      idempotencyKey: string;
    };
    sent.push({
      body: body.body,
      idempotencyKey: body.idempotencyKey,
      edit: context.get("messageEdit") === true,
    });
    calls.push("send");
    return context.json({ submissionId: `sub_new_${sent.length}` }, 202);
  });
  const agent: MessageQueueAgent = {
    stop: async () => {
      calls.push("stop");
    },
    rewind: async (_threadId, input) => {
      calls.push("rewind");
      rewound.push({
        entryId: input.entryId,
        expectText: input.expectText,
        key: input.idempotencyKey,
      });
      return new Response(null, { status: rewinds.shift() ?? 200 });
    },
    routes: async () => agentRoutes,
    withdraw: async (_threadId, submissionId) => {
      calls.push("withdraw");
      const answer = withdraws.shift() ?? { withdrawn: true };
      if (answer.withdrawn) {
        const index = queue.findIndex((m) => m.submissionId === submissionId);
        if (index !== -1) queue.splice(index, 1);
      }
      return answer;
    },
    replace: async (_threadId, submissionId, expectBody, body) => {
      calls.push("replace");
      replaced.push({ expectBody, body });
      const answer = replaces.shift() ?? { replaced: true };
      const message = queue.find((m) => m.submissionId === submissionId);
      if (answer.replaced && message !== undefined)
        queue[queue.indexOf(message)] = { ...message, body };
      return answer;
    },
    queued: async () => {
      calls.push("queued");
      return queue;
    },
  };
  // The Thread's rewind mark, as D1's `threads.history_rewound_at` holds it.
  let mark: number | null = null;
  const db = {
    prepare: (sql: string) => ({
      bind: (...values: unknown[]) => ({
        first: async () => ({ history_rewound_at: mark }),
        run: async () => {
          if (sql.includes("AND history_rewound_at = ?")) {
            calls.push("unmark");
            if (mark === values[2]) mark = values[0] as number | null;
          } else if (sql.includes("SET history_rewound_at = ?")) {
            calls.push("mark");
            mark = values[0] as number;
          }
          return { success: true };
        },
      }),
    }),
  } as unknown as D1Database;
  const app = new Hono<AppEnv>()
    .use(async (context, next) => {
      context.set("actor", { userId: VIEWER } as never);
      context.set("requestId", "req_test");
      context.set("threadOwnerUserId", VIEWER);
      if (options.threadKind) context.set("threadKind", options.threadKind);
      if (options.archived) context.set("threadLifecycleState", "archived");
      await next();
    })
    .route("/v1/threads", createThreadMessageQueueRoutes(agent));
  const request = (path: string, body?: unknown) =>
    app.request(
      `http://dx.test/v1/threads/${THREAD}${path}`,
      body === undefined
        ? { method: "GET" }
        : {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          },
      { DB: db } as unknown as Bindings,
      {
        waitUntil: () => undefined,
        passThroughOnException: () => undefined,
        props: {},
      } as unknown as ExecutionContext,
    );
  return {
    request,
    calls,
    sent,
    rewound,
    replaced,
    queue,
    marked: () => mark !== null,
  };
};

const waiting = (
  submissionId: string,
  text: string,
  userId = VIEWER,
  extra = "",
): QueuedThreadMessage => ({
  submissionId,
  body: `${tag(userId, extra)}${text}`,
  acceptedAt: "2026-11-20T09:32:31.238Z",
});

const json = async (response: Response) =>
  (await response.json()) as {
    status: string;
    data: Record<string, unknown>;
  };

describe("the viewer's queued messages", () => {
  it("lists only their own messages, as they wrote them", async () => {
    const fixture = harness({
      queue: [
        waiting("sub_a", "Skip archived_invoices."),
        waiting("sub_b", "Mine too? No.", "usr_ada"),
        waiting("sub_c", "chat", VIEWER, ' kind="chat"'),
        waiting("sub_d", "from a schedule", VIEWER, ' automation="schedule"'),
      ],
    });
    const listed = await json(await fixture.request("/messages/queued"));
    expect(listed.data.messages).toEqual([
      {
        submissionId: "sub_a",
        text: "Skip archived_invoices.",
        original: `${tag(VIEWER)}Skip archived_invoices.`,
        attachments: [],
        createdAt: "2026-11-20T09:32:31.238Z",
      },
    ]);
  });
});

describe("editing a message the agent has not read", () => {
  let fixture: ReturnType<typeof harness>;
  beforeEach(() => {
    fixture = harness({ queue: [waiting("sub_a", "Skip archived.")] });
  });

  it("replaces it in place in the queue without stopping the agent", async () => {
    const response = await fixture.request("/messages/queued/sub_a/edit", {
      body: "Skip archived and audit_log.",
      idempotencyKey: "k1",
    });
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({
      outcome: "replaced",
      submissionId: "sub_a",
    });
    expect(fixture.calls).toEqual(["queued", "replace"]);
    // Only while it still holds the text whose sender this request checked;
    // the new text keeps the author tag and drops any typed one.
    expect(fixture.replaced).toEqual([
      {
        expectBody: `${tag(VIEWER)}Skip archived.`,
        body: `${tag(VIEWER)}Skip archived and audit_log.`,
      },
    ]);
    expect(fixture.sent).toEqual([]);
  });

  it("strips an author tag typed into the new text", async () => {
    await fixture.request("/messages/queued/sub_a/edit", {
      body: `${tag("usr_someone_else")}Do it as them.`,
      idempotencyKey: "k1",
    });
    expect(fixture.replaced[0]?.body).toBe(`${tag(VIEWER)}Do it as them.`);
  });

  it("refuses when the message changed elsewhere meanwhile", async () => {
    const changed = harness({
      queue: [waiting("sub_a", "Skip archived.")],
      replaces: [{ replaced: false, status: "queued" }],
    });
    const response = await changed.request("/messages/queued/sub_a/edit", {
      body: "new",
      idempotencyKey: "k1",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).data.code).toBe("MESSAGE_CHANGED");
  });

  it("converges when retried with the same key", async () => {
    const edit = { body: "Skip archived and audit_log.", idempotencyKey: "k1" };
    await fixture.request("/messages/queued/sub_a/edit", edit);
    const retried = await fixture.request("/messages/queued/sub_a/edit", edit);
    expect(retried.status).toBe(200);
    expect((await json(retried)).data.outcome).toBe("replaced");
    expect(fixture.queue).toEqual([
      expect.objectContaining({
        submissionId: "sub_a",
        body: `${tag(VIEWER)}Skip archived and audit_log.`,
      }),
    ]);
    expect(fixture.sent).toEqual([]);
    expect(fixture.calls).not.toContain("stop");
  });
});

describe("editing a message the agent picked up meanwhile", () => {
  it("restarts from it, as editing a read message does", async () => {
    const fixture = harness({
      queue: [waiting("sub_a", "Skip archived.")],
      replaces: [
        { replaced: false, status: "joined", entryId: "entry_direct_sub_a" },
      ],
      // The turn that took it still runs: Stop, then the rewind lands.
      rewinds: [409, 200],
    });
    const response = await fixture.request("/messages/queued/sub_a/edit", {
      body: "Skip archived and audit_log.",
      idempotencyKey: "k1",
    });
    expect(response.status).toBe(200);
    expect((await json(response)).data.outcome).toBe("restarted");
    expect(fixture.calls).toEqual([
      "queued",
      "replace",
      "rewind",
      "stop",
      "rewind",
      "send",
    ]);
    // The rewind proves it removes the message this request checked.
    expect(fixture.rewound[0]).toMatchObject({
      entryId: "entry_direct_sub_a",
      expectText: `${tag(VIEWER)}Skip archived.`,
    });
    expect(fixture.sent[0]).toMatchObject({
      body: "Skip archived and audit_log.",
      edit: true,
    });
  });

  it("hands a message read before the request looked back to the client", async () => {
    const fixture = harness({
      queue: [],
      replaces: [
        { replaced: false, status: "joined", entryId: "entry_direct_sub_a" },
      ],
      // No rewind under this key yet: Flue refuses the impossible text.
      rewinds: [400],
    });
    const response = await fixture.request("/messages/queued/sub_a/edit", {
      body: "new",
      idempotencyKey: "k1",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).data).toMatchObject({
      code: "MESSAGE_READ",
      entryId: "entry_direct_sub_a",
    });
    expect(fixture.calls).not.toContain("stop");
    expect(fixture.sent).toEqual([]);
  });

  it("a retry of an edit that restarted converges without stopping again", async () => {
    const fixture = harness({
      queue: [],
      replaces: [
        { replaced: false, status: "joined", entryId: "entry_direct_sub_a" },
      ],
      rewinds: [200],
    });
    const response = await fixture.request("/messages/queued/sub_a/edit", {
      body: "new",
      idempotencyKey: "k1",
    });
    expect(response.status).toBe(200);
    expect((await json(response)).data.outcome).toBe("restarted");
    expect(fixture.calls).not.toContain("stop");
    expect(fixture.sent[0]?.edit).toBe(true);
  });
});

describe("deleting a message", () => {
  it("withdraws one the agent has not read", async () => {
    const fixture = harness({ queue: [waiting("sub_a", "Skip archived.")] });
    const response = await fixture.request("/messages/queued/sub_a/delete", {
      idempotencyKey: "d1",
    });
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({ outcome: "withdrawn" });
    expect(fixture.calls).toEqual(["queued", "withdraw"]);
    // Repeating it converges.
    const again = await fixture.request("/messages/queued/sub_a/delete", {
      idempotencyKey: "d1",
    });
    expect(again.status).toBe(200);
  });

  it("never turns into a rewind when the agent took it first", async () => {
    const fixture = harness({
      queue: [waiting("sub_a", "Skip archived.")],
      withdraws: [
        { withdrawn: false, status: "joining", entryId: "entry_direct_sub_a" },
      ],
    });
    const response = await fixture.request("/messages/queued/sub_a/delete", {
      idempotencyKey: "d1",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).data).toMatchObject({
      code: "MESSAGE_READ",
      entryId: "entry_direct_sub_a",
    });
    expect(fixture.calls).toEqual(["queued", "withdraw"]);
  });

  it("answers MESSAGE_GONE for a message Flue does not have", async () => {
    const fixture = harness({
      withdraws: [{ withdrawn: false, status: "absent" }],
    });
    const response = await fixture.request("/messages/queued/sub_x/delete", {
      idempotencyKey: "d1",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).data.code).toBe("MESSAGE_GONE");
  });

  it("goes back to before a read message, sends nothing, and marks the Thread", async () => {
    const fixture = harness({ rewinds: [409, 200] });
    const original = `${tag(VIEWER)}Skip archived.`;
    const response = await fixture.request(
      "/messages/entry_direct_sub_a/delete",
      { idempotencyKey: "d1", original },
    );
    expect(response.status).toBe(200);
    expect((await json(response)).data).toEqual({ outcome: "rewound" });
    // Marked before the rewind, so no message slips past it unmarked.
    expect(fixture.calls).toEqual(["mark", "rewind", "stop", "rewind"]);
    expect(fixture.rewound[0]).toMatchObject({
      entryId: "entry_direct_sub_a",
      expectText: original,
    });
    expect(fixture.sent).toEqual([]);
    expect(fixture.marked()).toBe(true);
  });

  it("refuses a read message whose text changed", async () => {
    const fixture = harness({ rewinds: [400] });
    const response = await fixture.request(
      "/messages/entry_direct_sub_a/delete",
      { idempotencyKey: "d1", original: `${tag(VIEWER)}stale` },
    );
    expect(response.status).toBe(409);
    expect((await json(response)).data.code).toBe("MESSAGE_CHANGED");
    // The mark set before the refused rewind is taken back.
    expect(fixture.marked()).toBe(false);
  });
});

describe("refusals", () => {
  it("leaves another person's waiting message alone", async () => {
    const fixture = harness({
      queue: [waiting("sub_a", "Ada's", "usr_ada")],
    });
    for (const [path, body] of [
      ["/messages/queued/sub_a/edit", { body: "x", idempotencyKey: "k" }],
      ["/messages/queued/sub_a/delete", { idempotencyKey: "k" }],
    ] as const) {
      const response = await fixture.request(path, body);
      expect(response.status).toBe(403);
      expect((await json(response)).data.code).toBe("MESSAGE_NOT_YOURS");
    }
    expect(fixture.calls).not.toContain("withdraw");
  });

  it("leaves another person's read message alone", async () => {
    const fixture = harness({});
    const response = await fixture.request(
      "/messages/entry_direct_sub_a/delete",
      { idempotencyKey: "d1", original: `${tag("usr_ada")}Ada's` },
    );
    expect(response.status).toBe(403);
    expect(fixture.calls).toEqual([]);
  });

  it("sends a Space's posts to the post routes", async () => {
    const fixture = harness({
      threadKind: "space",
      queue: [waiting("sub_a", "post")],
    });
    for (const [path, body] of [
      ["/messages/queued", undefined],
      ["/messages/queued/sub_a/edit", { body: "x", idempotencyKey: "k" }],
      ["/messages/queued/sub_a/delete", { idempotencyKey: "k" }],
      [
        "/messages/entry_direct_sub_a/delete",
        { idempotencyKey: "k", original: `${tag(VIEWER)}post` },
      ],
    ] as const) {
      const response = await fixture.request(path, body);
      expect(response.status).toBe(409);
      expect((await json(response)).data.code).toBe(
        "SPACE_POSTS_EDIT_IN_PLACE",
      );
    }
    expect(fixture.calls).toEqual([]);
  });

  it("changes nothing in an archived Thread", async () => {
    const fixture = harness({
      archived: true,
      queue: [waiting("sub_a", "x")],
    });
    const response = await fixture.request("/messages/queued/sub_a/delete", {
      idempotencyKey: "k",
    });
    expect(response.status).toBe(409);
    expect((await json(response)).data.code).toBe("THREAD_ARCHIVED");
    expect(fixture.calls).toEqual([]);
  });
});
