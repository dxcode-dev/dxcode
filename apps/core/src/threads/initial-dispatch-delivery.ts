import type { ThreadId } from "@dx/domain";
import { dispatch, getAgentInstance } from "@flue/runtime";
import type { Hono, MiddlewareHandler } from "hono";
import { DxAgent } from "../agents/dx-agent.js";
import { linkMessageAttachments } from "../attachments/message.js";
import type { AppEnv, Bindings } from "../http/types.js";
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

const firstMessagePending = async (db: D1Database, threadId: ThreadId) =>
  (await db
    .prepare(
      `SELECT 1 AS pending FROM thread_initial_dispatch
        WHERE thread_id = ? AND state = 'pending'`,
    )
    .bind(threadId)
    .first<{ pending: number }>()) !== null;

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
 * every `pollMs` and answers with Flue's real answer. The read delivers
 * nothing: whoever reads, viewers included, starts no run. Only a 404 looks
 * further, so other reads cost nothing. A Thread with neither (made without
 * a first message, or whose first message failed) gets Flue's 404 at once,
 * and so does any read still unanswered after `waitMs`.
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
    await next();
    if (context.req.method !== "GET" || context.res.status !== 404) return;
    const threadId = context.req.param("threadId") as ThreadId | undefined;
    if (threadId === undefined) return;
    try {
      const db = context.env.DB as D1Database;
      const arriving = async () =>
        (await firstMessagePending(db, threadId)) ||
        (await agentStarted(threadId));
      if (!(await arriving())) return;
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
      for (let attempt = 1; Date.now() < deadline; attempt++) {
        if (context.req.raw.signal.aborted) return;
        await pause(pollMs);
        const answer = await read();
        if (answer.status !== 404) {
          context.res = undefined;
          context.res = answer;
          return;
        }
        await answer.body?.cancel().catch(() => undefined);
        // About once a second: a message that failed stops the wait.
        if (
          attempt % Math.max(1, Math.round(1_000 / pollMs)) === 0 &&
          !(await arriving())
        ) {
          const last = await read();
          if (last.status !== 404) {
            context.res = undefined;
            context.res = last;
          }
          return;
        }
      }
    } catch {
      // Flue's answer stands; the page reads again.
    }
  };
