import {
  THREAD_PANE_LAYOUT_MAX_BYTES,
  type ThreadPaneLayout,
  ThreadPaneLayoutErrorResponseSchema,
  ThreadPaneLayoutParamsSchema,
  ThreadPaneLayoutResponseSchema,
  UpdateThreadPaneLayoutRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadPaneLayoutLogger } from "../logging.js";
import {
  canUseSharedThreads,
  findSharedThreadGrant,
} from "../thread-sharing/access.js";

const decodeLayout = Schema.decodeUnknownOption(
  UpdateThreadPaneLayoutRequestSchema,
);
const encodeLayout = Schema.encodeUnknownSync(
  UpdateThreadPaneLayoutRequestSchema,
);

/** The person's saved layout for the Thread; a row the schema rejects is none. */
export const readThreadPaneLayout = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
): Promise<ThreadPaneLayout | null> => {
  const row = await db
    .prepare(
      `SELECT layout FROM thread_pane_layout
        WHERE thread_id = ?1 AND user_id = ?2`,
    )
    .bind(threadId, userId)
    .first<{ layout: string }>();
  if (row === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.layout);
  } catch {
    return null;
  }
  return Option.getOrNull(decodeLayout(parsed));
};

export const writeThreadPaneLayout = async (
  db: D1Database,
  threadId: string,
  userId: UserId,
  layout: ThreadPaneLayout,
  now = new Date(),
) => {
  await db
    .prepare(
      `INSERT INTO thread_pane_layout (thread_id, user_id, layout, updated_at)
       SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM threads WHERE id = ?1)
       ON CONFLICT (thread_id, user_id) DO UPDATE SET
         layout = excluded.layout,
         updated_at = excluded.updated_at`,
    )
    .bind(
      threadId,
      userId,
      JSON.stringify(encodeLayout(layout)),
      now.toISOString(),
    )
    .run();
};

const errorJson = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "THREAD_NOT_FOUND" | "PERSISTENCE_UNAVAILABLE",
  message: string,
  status: 400 | 404 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadPaneLayoutErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

/** The Thread exists, is not deleted, and the principal can read it. */
const readableThread = async (
  db: D1Database,
  threadId: string,
  principal: AppEnv["Variables"]["principal"],
) => {
  const thread = await db
    .prepare(
      `SELECT owner_user_id FROM threads
        WHERE id = ? AND lifecycle_state != 'deleted'`,
    )
    .bind(threadId)
    .first<{ owner_user_id: string }>();
  return (
    thread !== null &&
    (thread.owner_user_id === principal.userId ||
      (canUseSharedThreads(principal) &&
        (await findSharedThreadGrant(db, threadId, principal.userId)) !==
          undefined))
  );
};

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, threadId: string, userId: UserId) => Promise<Response>,
) => {
  const params = Schema.decodeUnknownOption(ThreadPaneLayoutParamsSchema)({
    threadId: context.req.param("threadId"),
  });
  if (Option.isNone(params))
    return errorJson(
      context,
      "INVALID_REQUEST",
      "Request validation failed.",
      400,
    );
  const db = context.env.DB;
  if (db === undefined)
    return errorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  const principal = context.get("principal");
  try {
    if (!(await readableThread(db, params.value.threadId, principal)))
      return errorJson(
        context,
        "THREAD_NOT_FOUND",
        "Thread was not found.",
        404,
      );
    return await run(db, params.value.threadId, principal.userId as UserId);
  } catch (cause) {
    threadPaneLayoutLogger.error("Thread pane layout request failed.", {
      event: "thread_pane_layout_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return errorJson(
      context,
      "PERSISTENCE_UNAVAILABLE",
      "Persistence is temporarily unavailable.",
      503,
    );
  }
};

const layoutResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  threadId: string,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadPaneLayoutResponseSchema)({
      status: "success",
      data: { layout: await readThreadPaneLayout(db, threadId, userId) },
    }),
    200,
  );

/**
 * `/v1/threads/:threadId/layout`: the signed-in person's panes
 * and tabs on the Thread, kept per person so a member's layout never
 * replaces the owner's.
 */
export const threadPaneLayoutRoutes = new Hono<AppEnv>()
  .get("/:threadId/layout", (context) =>
    handle(context, (db, threadId, userId) =>
      layoutResponse(context, db, threadId, userId),
    ),
  )
  .put("/:threadId/layout", (context) =>
    handle(context, async (db, threadId, userId) => {
      const text = await context.req.text().catch(() => "");
      if (text.length > THREAD_PANE_LAYOUT_MAX_BYTES)
        return errorJson(
          context,
          "INVALID_REQUEST",
          "Request validation failed.",
          400,
        );
      let body: unknown;
      try {
        body = JSON.parse(text);
      } catch {
        body = undefined;
      }
      const layout = decodeLayout(body);
      if (Option.isNone(layout))
        return errorJson(
          context,
          "INVALID_REQUEST",
          "Request validation failed.",
          400,
        );
      await writeThreadPaneLayout(db, threadId, userId, layout.value);
      return layoutResponse(context, db, threadId, userId);
    }),
  );
