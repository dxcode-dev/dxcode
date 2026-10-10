import {
  GetThreadMembersResponseSchema,
  ListSharedThreadsResponseSchema,
  ThreadFollowResponseSchema,
  type ThreadSharingErrorCode,
  ThreadSharingErrorResponseSchema,
  UpdateThreadSharingRequestSchema,
  UpdateThreadSharingResponseSchema,
} from "@dx/api";
import { ThreadId, type UserId } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { threadSharingLogger } from "../logging.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { threadListItem } from "../threads/list-projection-d1.js";
import { decodeThreadRows } from "../threads/repository-d1.js";
import { canUseSharedThreads } from "./access.js";
import { followThread, threadMembers, unfollowThread } from "./members.js";
import {
  listSharedThreadRows,
  ThreadSharingError,
  threadSharingDecorations,
  updateThreadSharing,
} from "./service.js";

const failure = (
  context: Context<AppEnv>,
  code: ThreadSharingErrorCode,
  status: 400 | 403 | 404 | 409 | 503,
  message: string,
) =>
  context.json(
    Schema.encodeUnknownSync(ThreadSharingErrorResponseSchema)({
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    }),
    status,
  );

const handle = async (
  context: Context<AppEnv>,
  run: (db: D1Database) => Promise<Response>,
) => {
  const db = context.env.DB;
  if (db === undefined)
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  try {
    return await run(db);
  } catch (error) {
    if (error instanceof ThreadSharingError)
      return failure(context, error.code, error.status, error.message);
    threadSharingLogger.error("Thread sharing request failed.", {
      event: "thread_sharing_request_failed",
      requestId: context.get("requestId"),
      cause: error,
    });
    return failure(
      context,
      "PERSISTENCE_UNAVAILABLE",
      503,
      "Persistence is temporarily unavailable.",
    );
  }
};

/** `PUT /v1/threads/:threadId/sharing`: the owner sets workspace access. */
export const threadSharingRoutes = new Hono<AppEnv>().put(
  "/:threadId/sharing",
  (context) =>
    handle(context, async (db) => {
      const threadId = Schema.decodeUnknownOption(ThreadId)(
        context.req.param("threadId"),
      );
      const body = Schema.decodeUnknownOption(UpdateThreadSharingRequestSchema)(
        await context.req.json().catch(() => undefined),
      );
      if (Option.isNone(threadId) || Option.isNone(body))
        return failure(
          context,
          "INVALID_REQUEST",
          400,
          "Request validation failed.",
        );
      const principal = context.get("principal");
      if (!canUseSharedThreads(principal))
        return failure(context, "THREAD_NOT_FOUND", 404, "Thread not found.");
      const result = await updateThreadSharing(db, {
        threadId: threadId.value,
        ownerUserId: principal.userId as UserId,
        request: body.value,
      });
      threadSharingLogger.info("Thread sharing changed.", {
        event: "thread_sharing_changed",
        requestId: context.get("requestId"),
        threadId: threadId.value,
        workspaceAccess: body.value.workspaceAccess,
      });
      await scheduleRealtimeInvalidation(
        () => context.executionCtx,
        context.env,
        threadId.value,
        "thread.invalidated",
        "audience",
      );
      return context.json(
        Schema.encodeUnknownSync(UpdateThreadSharingResponseSchema)({
          status: "success",
          data: { threadId: threadId.value, ...result },
        }),
        200,
      );
    }),
);

const setFollowing = (context: Context<AppEnv>, following: boolean) =>
  handle(context, async (db) => {
    const threadId = context.req.param("threadId") as ThreadId;
    const actor = context.get("actor");
    // The owner always follows their own Thread.
    if (context.get("threadAccess") !== "owner") {
      if (following) await followThread(db, threadId, [actor.userId as UserId]);
      else await unfollowThread(db, threadId, actor.userId as UserId);
    }
    return context.json(
      Schema.encodeUnknownSync(ThreadFollowResponseSchema)({
        status: "success",
        data: {
          following: following || context.get("threadAccess") === "owner",
        },
      }),
      200,
    );
  });

/**
 * Mounted at `/v1/threads` behind `authorizeThread`: the members who can be
 * tagged in a shared Thread, and following it.
 */
export const threadMemberRoutes = new Hono<AppEnv>()
  .get("/:threadId/members", (context) =>
    handle(context, async (db) =>
      context.json(
        Schema.encodeUnknownSync(GetThreadMembersResponseSchema)({
          status: "success",
          data: {
            members: await threadMembers(
              db,
              context.req.param("threadId") as ThreadId,
            ),
          },
        }),
        200,
      ),
    ),
  )
  .put("/:threadId/follow", (context) => setFollowing(context, true))
  .delete("/:threadId/follow", (context) => setFollowing(context, false));

/**
 * `GET /v1/shared-threads`: active Threads other members shared with me that
 * I follow, each with its Project's name.
 */
export const sharedThreadRoutes = new Hono<AppEnv>().get("/", (context) =>
  handle(context, async (db) => {
    const principal = context.get("principal");
    if (!canUseSharedThreads(principal))
      return context.json(
        Schema.encodeUnknownSync(ListSharedThreadsResponseSchema)({
          status: "success",
          data: { items: [] },
        }),
        200,
      );
    const rows = await listSharedThreadRows(db, principal.userId as UserId);
    const threads = await Effect.runPromise(decodeThreadRows(rows));
    const access = new Map(rows.map((row) => [row.id, row.access]));
    const projectNames = new Map(
      rows.map((row) => [row.id, row.project_name.slice(0, 256)]),
    );
    const decorations = await threadSharingDecorations(
      db,
      threads.map(({ id }) => id),
    );
    return context.json(
      Schema.encodeUnknownSync(ListSharedThreadsResponseSchema)({
        status: "success",
        data: {
          items: threads.map((thread) => ({
            ...threadListItem(thread),
            access:
              access.get(thread.id) === "contribute" ? "contribute" : "view",
            projectName: projectNames.get(thread.id),
            ...decorations.get(thread.id),
          })),
        },
      }),
      200,
    );
  }),
);
