import {
  DeleteThreadInvalidRequestResponseSchema,
  DeleteThreadNotFoundResponseSchema,
  DeleteThreadPersistenceUnavailableResponseSchema,
  DeleteThreadResponseSchema,
} from "@dx/api";
import { ThreadId, type UserId } from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { Hono } from "hono";
import { authorizeThreadRequest } from "../auth/authorize-thread.js";
import { ExecutionWorkspaces } from "../execution/execution-workspaces.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { threadDeletionLogger } from "../logging.js";
import { scheduleRealtimeInvalidation } from "../realtime/publication.js";
import { eraseAgentHistory } from "./agent-history.js";
import { purgeDeletedThread, type ThreadCleanup } from "./cleanup.js";
import {
  childThreadIds,
  findOwnedDeletion,
  tombstoneThread,
} from "./tombstone.js";

/** The deployment's cleanup: Flue's agent object and the Thread's Orb. */
export const deployedThreadCleanup = (bindings: Bindings): ThreadCleanup => ({
  eraseAgentHistory: (threadId) => eraseAgentHistory(bindings, threadId),
  destroySandbox: (threadId) => ExecutionWorkspaces.destroy(threadId),
});

/**
 * `DELETE /v1/threads/:threadId`: the owner deletes a Thread for good. The
 * tombstone is written first, so the Thread disappears and refuses every
 * request at once; then its history, sandbox, search text, and files are
 * removed. A cleanup that fails partway still reports the Thread deleted,
 * with `cleanup: "pending"`, and the cron finishes it. Repeating the request
 * for a deleted Thread retries its cleanup.
 */
export const createThreadDeletionRoutes = (
  cleanupFor: (bindings: Bindings) => ThreadCleanup = deployedThreadCleanup,
) => {
  const routes = new Hono<AppEnv>();
  routes.delete("/:threadId", async (context) => {
    const requestId = context.get("requestId");
    const db = context.env.DB;
    const unavailable = () =>
      context.json(
        Schema.encodeUnknownSync(
          DeleteThreadPersistenceUnavailableResponseSchema,
        )({
          status: "error",
          data: {
            code: "PERSISTENCE_UNAVAILABLE",
            message: "Persistence is temporarily unavailable.",
            requestId,
          },
        }),
        503,
      );
    const threadId = Schema.decodeUnknownOption(ThreadId)(
      context.req.param("threadId"),
    );
    if (Option.isNone(threadId))
      return context.json(
        Schema.encodeUnknownSync(DeleteThreadInvalidRequestResponseSchema)({
          status: "error",
          data: {
            code: "INVALID_REQUEST",
            message: "Request validation failed.",
            requestId,
          },
        }),
        400,
      );
    if (db === undefined) return unavailable();
    const principal = context.get("principal");
    const ownerUserId = principal.userId as UserId;
    let deletedAt: string;
    let invalidated: ReadonlyArray<ThreadId>;
    try {
      // Only the owner deletes; a member of a shared Thread cannot.
      const authorization = await Effect.runPromise(
        authorizeThreadRequest(threadId.value, principal, db),
      );
      if (authorization.authorized && authorization.access === "owner") {
        const children = await childThreadIds(db, threadId.value);
        deletedAt = new Date().toISOString();
        if (
          !(await tombstoneThread(db, threadId.value, ownerUserId, deletedAt))
        )
          throw new Error("The Thread changed while it was being deleted.");
        invalidated = [threadId.value, ...children];
        threadDeletionLogger.info("Thread deleted.", {
          event: "thread_deleted",
          requestId,
          threadId: threadId.value,
          detachedChildren: children.length,
        });
      } else {
        const deletion = await findOwnedDeletion(
          db,
          threadId.value,
          ownerUserId,
        );
        if (deletion === undefined)
          return context.json(
            Schema.encodeUnknownSync(DeleteThreadNotFoundResponseSchema)({
              status: "error",
              data: {
                code: "THREAD_NOT_FOUND",
                message: "Thread was not found.",
                requestId,
              },
            }),
            404,
          );
        deletedAt = deletion.requestedAt;
        invalidated = [];
        if (deletion.completedAt !== null)
          return context.json(
            Schema.encodeUnknownSync(DeleteThreadResponseSchema)({
              status: "success",
              data: {
                threadId: threadId.value,
                deletedAt,
                cleanup: "complete",
              },
            }),
            200,
          );
      }
    } catch (cause) {
      threadDeletionLogger.error("Thread deletion failed.", {
        event: "thread_delete_failed",
        requestId,
        threadId: threadId.value,
        cause,
      });
      return unavailable();
    }
    // Open apps drop the Thread, and show its children at the top level.
    for (const id of invalidated)
      await scheduleRealtimeInvalidation(
        () => context.executionCtx,
        context.env,
        id,
        "thread.invalidated",
      );
    const cleanup = await purgeDeletedThread(
      context.env,
      cleanupFor(context.env),
      threadId.value,
      ownerUserId,
    ).catch((cause) => {
      threadDeletionLogger.warn("Thread cleanup could not be recorded.", {
        event: "thread_cleanup_unrecorded",
        threadId: threadId.value,
        cause,
      });
      return { complete: false };
    });
    return context.json(
      Schema.encodeUnknownSync(DeleteThreadResponseSchema)({
        status: "success",
        data: {
          threadId: threadId.value,
          deletedAt,
          cleanup: cleanup.complete ? "complete" : "pending",
        },
      }),
      200,
    );
  });
  return routes;
};

export const threadDeletionRoutes = createThreadDeletionRoutes();
