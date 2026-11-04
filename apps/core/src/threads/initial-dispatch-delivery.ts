import type { ThreadId } from "@dx/domain";
import { dispatch, getAgentInstance } from "@flue/runtime";
import type { Hono, MiddlewareHandler } from "hono";
import { DxAgent } from "../agents/dx-agent.js";
import { linkMessageAttachments } from "../attachments/message.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import {
  deliverInitialDispatch,
  readPendingInitialDispatch,
  sweepInitialDispatches,
} from "./initial-dispatch.js";

/** Delivery of stored first messages to DxAgent; see `initial-dispatch.ts`. */
const initialDispatchDelivery = (bindings: Bindings) => {
  const db = bindings.DB as D1Database;
  return {
    db,
    dispatch: (request: Parameters<typeof dispatch>[1]) =>
      dispatch(DxAgent, request),
    linkAttachments: (pending: {
      readonly threadId: ThreadId;
      readonly senderUserId: string;
      readonly attachmentIds: ReadonlyArray<string>;
    }) =>
      linkMessageAttachments(db, {
        threadId: pending.threadId,
        senderUserId: pending.senderUserId,
        rows: pending.attachmentIds.map((id) => ({ id })),
      }),
    invalidate: (threadId: ThreadId) =>
      publishRealtimeInvalidation(bindings, threadId, "thread.invalidated"),
  };
};

/**
 * The cron's pass over first messages no request finished delivering.
 */
export const sweepPendingInitialDispatches = (
  bindings: Bindings,
  now: number,
) => sweepInitialDispatches(initialDispatchDelivery(bindings), now);

/**
 * A send that would create the Thread's agent (`uid: null`) while the
 * Thread's first message is still on its way delivers that message first,
 * so the first message stays first; one that failed to start is dropped,
 * since the person sent this message instead of pressing Retry. Only
 * creating sends read the row: a client that knows the agent exists
 * conditions on its uid, and a send with neither a uid nor creation data
 * cannot create the agent.
 */
export const deliverFirstMessageBeforeCreatingSend: MiddlewareHandler<
  AppEnv
> = async (context, next) => {
  if (context.req.method !== "POST") return next();
  const body = (await context.req.raw
    .clone()
    .json()
    .catch(() => undefined)) as { readonly uid?: unknown } | undefined;
  if (body?.uid !== null) return next();
  // Best effort: a failure here never refuses the send itself.
  try {
    const delivery = initialDispatchDelivery(context.env);
    const threadId = context.req.param("threadId") as ThreadId;
    const [pending] = await Promise.all([
      readPendingInitialDispatch(delivery.db, threadId).catch(() => undefined),
      // A message sent instead of Retry replaces a first message that
      // failed.
      delivery.db
        .prepare(
          "DELETE FROM thread_initial_dispatch WHERE thread_id = ? AND state = 'failed'",
        )
        .bind(threadId)
        .run()
        .catch(() => undefined),
    ]);
    if (pending !== undefined)
      await deliverInitialDispatch(
        { ...delivery, retryDelaysMs: [250] },
        pending,
      ).catch(() => undefined);
  } catch {
    // The send goes on; the sweep still delivers a pending first message.
  }
  return next();
};

/** What answers a read of the Thread's agent: Flue's router. */
type AgentReader = Pick<Hono<AppEnv>, "fetch">;

/** The Thread's first message: on its way, failed, or gone (delivered). */
const firstMessageState = async (db: D1Database, threadId: ThreadId) =>
  (
    await db
      .prepare("SELECT state FROM thread_initial_dispatch WHERE thread_id = ?")
      .bind(threadId)
      .first<{ state: "pending" | "failed" }>()
  )?.state;

/** Flue holds an agent for the Thread: its first message was admitted. */
const agentExists = async (threadId: ThreadId) =>
  (await getAgentInstance(DxAgent, threadId)) !== null;

const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * A read of a new Thread's agent while its first message is still on its
 * way (#1626). Creation answers before the agent holds the message, so Flue
 * would answer the page's first history read with a 404 that the browser
 * logs: before the agent admits the first message, and for a moment after,
 * until the conversation is readable. When Flue answers a read 404 while
 * the Thread's first message is pending, or while its agent exists but its
 * conversation is not readable yet, the read waits: it asks Flue again
 * every `pollMs` and answers with Flue's real answer. Once waiting, it
 * waits until Flue answers, the first message is marked failed, or `waitMs`
 * passes: the delivery deleting the row means the message was admitted, so
 * the conversation is about to be readable (#1626, seen on staging). The
 * read delivers nothing: whoever reads, viewers included, starts no run.
 * Only a 404 looks further, so other reads cost nothing. A Thread with
 * neither (made without a first message, or whose first message failed)
 * gets Flue's 404 at once.
 */
export const answerReadsWhileFirstMessagePending =
  (
    flue: AgentReader,
    {
      pollMs = 250,
      waitMs = 15_000,
      agentStarted = agentExists,
    }: {
      pollMs?: number;
      waitMs?: number;
      /** Whether Flue holds an agent for the Thread. */
      agentStarted?: (threadId: ThreadId) => Promise<boolean>;
    } = {},
  ): MiddlewareHandler<AppEnv> =>
  async (context, next) => {
    // Read before `next()`: afterwards Hono resolves params against Flue's
    // own route, which names the Thread `:id`, so `threadId` is gone.
    const threadId = context.req.param("threadId") as ThreadId | undefined;
    await next();
    if (context.req.method !== "GET" || context.res.status !== 404) return;
    if (threadId === undefined) return;
    const startedAt = Date.now();
    let state: "pending" | "failed" | undefined;
    let agent: boolean | "error" | undefined;
    let attempts = 0;
    // One line per read Flue answered 404, so a read that still ends 404 says why.
    const report = (outcome: string, cause?: unknown) =>
      threadPersistenceLogger.info("A new Thread's agent read waited.", {
        event: "agent_read_first_message_wait",
        threadId,
        outcome,
        state: state ?? "none",
        agent: agent === undefined ? "unchecked" : String(agent),
        attempts,
        waitedMs: Date.now() - startedAt,
        ...(cause === undefined
          ? {}
          : {
              code: cause instanceof Error ? cause.name : "UNKNOWN",
              detail: cause instanceof Error ? cause.message.slice(0, 200) : "",
            }),
      });
    try {
      const db = context.env.DB as D1Database;
      state = await firstMessageState(db, threadId);
      if (state === undefined)
        agent = await agentStarted(threadId).catch(() => "error" as const);
      // A failed lookup is not a reason to wait.
      const waiting = state === "pending" || agent === true;
      if (!waiting) return report("not-waiting");
      // The same read again: Flue's router serves its own paths from the
      // Thread ID on.
      const url = new URL(context.req.url);
      url.pathname = context.req.path.slice(
        context.req.path.indexOf(`/${threadId}`),
      );
      const executionContext = (() => {
        try {
          return context.executionCtx;
        } catch {
          return undefined;
        }
      })();
      const read = () =>
        flue.fetch(
          new Request(url, context.req.raw),
          context.env,
          executionContext,
        );
      const deadline = Date.now() + waitMs;
      for (attempts = 1; Date.now() < deadline; attempts++) {
        if (context.req.raw.signal.aborted) return report("aborted");
        await pause(pollMs);
        const answer = await read();
        if (answer.status !== 404) {
          context.res = undefined;
          context.res = answer;
          return report(`answered-${answer.status}`);
        }
        await answer.body?.cancel().catch(() => undefined);
        // About once a second: a message that failed stops the wait. One
        // delivered (row gone) or still on its way keeps it.
        if (
          attempts % Math.max(1, Math.round(1_000 / pollMs)) === 0 &&
          (await firstMessageState(db, threadId).catch(() => undefined)) ===
            "failed"
        )
          return report("failed");
      }
      report("timed-out");
    } catch (cause) {
      // Flue's answer stands; the page reads again.
      report("error", cause);
    }
  };
