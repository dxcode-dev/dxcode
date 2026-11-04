import {
  ThreadDraftErrorResponseSchema,
  ThreadDraftParamsSchema,
  type ThreadDraftResponse,
  ThreadDraftResponseSchema,
  UpdateThreadDraftRequestSchema,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadDraftLogger } from "../logging.js";
import { canUseSharedThreads } from "../thread-sharing/access.js";
import {
  readThreadDraft,
  threadDraftReadable,
  writeThreadDraft,
} from "./thread-draft-store.js";

const decodeUpdate = Schema.decodeUnknownOption(UpdateThreadDraftRequestSchema);

const errorJson = (
  context: Context<AppEnv>,
  code: "INVALID_REQUEST" | "THREAD_NOT_FOUND" | "PERSISTENCE_UNAVAILABLE",
  message: string,
  status: 400 | 404 | 503,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadDraftErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database, threadId: string, userId: UserId) => Promise<Response>,
) => {
  const params = Schema.decodeUnknownOption(ThreadDraftParamsSchema)({
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
    if (
      !(await threadDraftReadable(
        db,
        params.value.threadId,
        principal.userId as UserId,
        { shared: canUseSharedThreads(principal) },
      ))
    )
      return errorJson(
        context,
        "THREAD_NOT_FOUND",
        "Thread was not found.",
        404,
      );
    return await run(db, params.value.threadId, principal.userId as UserId);
  } catch (cause) {
    threadDraftLogger.error("Thread draft request failed.", {
      event: "thread_draft_request_failed",
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

const draftResponse = (context: Context<AppEnv>, text: string) =>
  context.json(
    Schema.encodeUnknownSync(ThreadDraftResponseSchema)({
      status: "success",
      data: { text },
    } satisfies ThreadDraftResponse),
    200,
  );

/**
 * `/v1/threads/:threadId/draft`: the signed-in person's unsent message in the
 * Thread's composer, kept per person so a member's draft never replaces the
 * owner's, and the same on each of their devices.
 */
export const threadDraftRoutes = new Hono<AppEnv>()
  .get("/:threadId/draft", (context) =>
    handle(context, async (db, threadId, userId) =>
      draftResponse(context, await readThreadDraft(db, threadId, userId)),
    ),
  )
  .put("/:threadId/draft", (context) =>
    handle(context, async (db, threadId, userId) => {
      const update = decodeUpdate(await context.req.json().catch(() => null));
      if (Option.isNone(update))
        return errorJson(
          context,
          "INVALID_REQUEST",
          "Request validation failed.",
          400,
        );
      await writeThreadDraft(db, threadId, userId, update.value.text);
      return draftResponse(context, update.value.text);
    }),
  );
