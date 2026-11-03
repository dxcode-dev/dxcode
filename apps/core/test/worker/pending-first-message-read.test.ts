import { env } from "cloudflare:test";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { useAgentAdmission } from "../../src/agents/admission.js";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import { answerReadsWhileFirstMessagePending } from "../../src/threads/initial-dispatch-delivery.js";
import {
  bindings,
  createProjectViaApi,
  createThreadViaApi,
  owner,
  principal,
} from "./product-route-fixture.js";

/**
 * The page reads a new Thread's agent right after `POST /v1/threads`
 * answers, before the agent may hold the first message (#1626). Ways this
 * could fail: the read answers 404 and the browser logs it; the read
 * delivers the message itself, so a viewer's read could start the owner's
 * run; a read waits on a message that failed; a Thread with no pending
 * message waits at all; a send is replayed.
 */

/**
 * Flue's router: a conversation exists only once the first message is
 * admitted, which the creating request's own delivery does `admitAfterMs`
 * after the read starts. Reads answer 404 before that, as Flue does.
 */
const fakeFlue = (
  admitAfterMs?: number,
  /** Flue already holds the agent; its conversation is not readable yet. */
  agentStarted = false,
) => {
  let admitted = false;
  const reads: string[] = [];
  const sends: string[] = [];
  const flue = new Hono<AppEnv>();
  flue.get("/:threadId", (context) => {
    reads.push(`history ${new URL(context.req.url).search}`);
    return admitted
      ? context.json({ entries: ["first message"] }, 200)
      : context.json({ error: { type: "stream_not_found" } }, 404);
  });
  flue.get("/:threadId/:subpath{.+}", (context) => {
    reads.push(context.req.param("subpath"));
    return admitted
      ? context.json({ live: true }, 200)
      : context.json({ error: { type: "stream_not_found" } }, 404);
  });
  flue.post("/:threadId", (context) => {
    sends.push(context.req.param("threadId"));
    return context.json({ error: { type: "invalid_request" } }, 404);
  });
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal);
    await next();
  });
  const routes = useAgentAdmission(new Hono<AppEnv>());
  const pendingReads = answerReadsWhileFirstMessagePending(flue, {
    pollMs: 50,
    waitMs: 1_500,
    agentStarted: async () => agentStarted || admitted,
  });
  routes.use("/:threadId", pendingReads);
  routes.use("/:threadId/:subpath{.+}", pendingReads);
  routes.route("/", flue);
  app.route("/v1/agents/dx", routes);
  app.onError(errorHandler);
  const request = (path: string, method = "GET") => {
    // The creating request's delivery lands while the read waits.
    if (admitAfterMs !== undefined)
      setTimeout(() => {
        admitted = true;
      }, admitAfterMs);
    return app.request(`/v1/agents/dx/${path}`, { method }, bindings);
  };
  return { request, reads, sends };
};

const storeFirstMessage = (threadId: string, state = "pending") =>
  env.DB.prepare(
    `INSERT INTO thread_initial_dispatch
       (thread_id, request_json, sender_user_id, state, failure_code, created_at)
     VALUES (?, '{}', ?, ?, ?, ?)`,
  )
    .bind(
      threadId,
      owner,
      state,
      state === "failed" ? "INITIAL_ADMISSION_UNAVAILABLE" : null,
      Date.now(),
    )
    .run();

const firstMessageRow = (threadId: string) =>
  env.DB.prepare(
    "SELECT state FROM thread_initial_dispatch WHERE thread_id = ?",
  )
    .bind(threadId)
    .first<{ state: string }>();

const newThread = async (name: string) =>
  (await createThreadViaApi((await createProjectViaApi(name)).data.id)).data;

describe("A new Thread's agent read while its first message is pending", () => {
  it("answers 200 with the first message once the agent has it, delivering nothing itself", async () => {
    const thread = await newThread("pending-first-read");
    await storeFirstMessage(thread.id);
    const { request, reads, sends } = fakeFlue(300);

    const history = await request(
      `${thread.id}?view=history&promptLimit=2&maxBytes=1048576`,
    );

    expect(history.status).toBe(200);
    await expect(history.json()).resolves.toEqual({
      entries: ["first message"],
    });
    // The same read, query and all, until the agent had the message.
    expect(reads.length).toBeGreaterThan(1);
    expect(new Set(reads)).toEqual(
      new Set(["history ?view=history&promptLimit=2&maxBytes=1048576"]),
    );
    // The read sent nothing and left the stored message to its delivery.
    expect(sends).toEqual([]);
    await expect(firstMessageRow(thread.id)).resolves.toEqual({
      state: "pending",
    });
  });

  it("waits too when the message was just admitted and its conversation is not readable yet", async () => {
    // The creating request's delivery already admitted the message and
    // removed the row; Flue holds the agent but answers 404 for a moment.
    const thread = await newThread("admitted-first-read");
    const { request, reads, sends } = fakeFlue(300, true);

    expect((await request(thread.id)).status).toBe(200);
    expect(reads.length).toBeGreaterThan(1);
    expect(sends).toEqual([]);
  });

  it("answers the live stream the same way", async () => {
    const thread = await newThread("pending-first-stream");
    await storeFirstMessage(thread.id);
    const { request, sends } = fakeFlue(200);

    expect((await request(`${thread.id}/stream?live=sse`)).status).toBe(200);
    expect(sends).toEqual([]);
  });

  it("gives up after its wait when the message never arrives, still delivering nothing", async () => {
    const thread = await newThread("pending-first-never");
    await storeFirstMessage(thread.id);
    const { request, sends } = fakeFlue();

    const started = Date.now();
    expect((await request(thread.id)).status).toBe(404);
    expect(Date.now() - started).toBeGreaterThanOrEqual(1_500);
    expect(sends).toEqual([]);
    await expect(firstMessageRow(thread.id)).resolves.toEqual({
      state: "pending",
    });
  });

  it("does not wait on a first message that failed, a Thread without one, or a send", async () => {
    const failed = await newThread("failed-first-read");
    await storeFirstMessage(failed.id, "failed");
    const flue = fakeFlue();
    const started = Date.now();
    expect((await flue.request(failed.id)).status).toBe(404);
    expect(Date.now() - started).toBeLessThan(1_000);
    expect(flue.reads).toHaveLength(1);

    // A Thread made without a first message has no conversation yet.
    const blank = await newThread("blank-first-read");
    const blankFlue = fakeFlue();
    expect((await blankFlue.request(blank.id)).status).toBe(404);
    expect(blankFlue.reads).toHaveLength(1);

    // A send Flue refuses is answered as Flue answered it, once.
    await storeFirstMessage(blank.id);
    expect((await blankFlue.request(blank.id, "POST")).status).toBe(404);
    expect(blankFlue.sends).toEqual([blank.id]);
  });
});
