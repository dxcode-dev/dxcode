import { NeedsYouErrorResponseSchema, NeedsYouResponseSchema } from "@dx/api";
import { ThreadId, type UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { notificationLogger } from "../logging.js";
import { scheduleUserInvalidation } from "../realtime/publication.js";
import { dismissNeedsYou, listNeedsYou } from "./repository.js";

const failure = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "PERSISTENCE_UNAVAILABLE",
) =>
  context.json(
    Schema.encodeUnknownSync(NeedsYouErrorResponseSchema)({
      status: "error",
      data:
        code === "INVALID_REQUEST"
          ? {
              code,
              message: "Request validation failed.",
              requestId: context.get("requestId"),
            }
          : {
              code,
              message: "Persistence is temporarily unavailable.",
              requestId: context.get("requestId"),
            },
    }),
    code === "INVALID_REQUEST" ? 400 : 503,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, userId: UserId) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined) return failure(context, "PERSISTENCE_UNAVAILABLE");
  try {
    return await run(db, context.get("principal").userId as UserId);
  } catch (cause) {
    notificationLogger.error("Needs-you request failed.", {
      event: "needs_you_request_failed",
      requestId: context.get("requestId"),
      cause,
    });
    return failure(context, "PERSISTENCE_UNAVAILABLE");
  }
};

const listResponse = async (
  context: Context<AppEnv>,
  db: D1Database,
  userId: UserId,
) =>
  context.json(
    Schema.encodeUnknownSync(NeedsYouResponseSchema)({
      status: "success",
      data: {
        items: await listNeedsYou(db, userId, new Date().toISOString()),
      },
    }),
    200,
  );

/**
 * Mounted at `/v1/needs-you`: the signed-in person's Threads that wait on
 * them, across every Project they reach.
 */
export const needsYouRoutes = new Hono<AppEnv>()
  .get("/", (context) =>
    handle(context, (db, userId) => listResponse(context, db, userId)),
  )
  .delete("/:threadId", (context) =>
    handle(context, async (db, userId) => {
      const threadId = Schema.decodeUnknownOption(ThreadId)(
        context.req.param("threadId"),
      );
      if (Option.isNone(threadId)) return failure(context, "INVALID_REQUEST");
      // Dismissing one already gone is the same outcome: the list without it.
      if (await dismissNeedsYou(db, userId, threadId.value))
        await scheduleUserInvalidation(
          () => context.executionCtx,
          context.env,
          userId,
          "needs-you.invalidated",
        );
      return listResponse(context, db, userId);
    }),
  );
