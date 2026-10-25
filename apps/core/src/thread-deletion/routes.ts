import {
  DELETE_THREAD_MAX_CHILDREN,
  DeleteThreadInvalidRequestResponseSchema,
  DeleteThreadNotFoundResponseSchema,
  DeleteThreadPersistenceUnavailableResponseSchema,
  DeleteThreadQuerySchema,
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
  listedChildThreadIds,
  tombstoneThreads,
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
 * for a deleted Thread retries its cleanup. `?includeChildren=true` also
 * deletes the children listed under it, in the same transaction.
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
    const query = Schema.decodeUnknownOption(DeleteThreadQuerySchema)(
      context.req.query(),
    );
    if (Option.isNone(threadId) || Option.isNone(query))
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
    const includeChildren = query.value.includeChildren === "true";
    let deletedAt: string;
    let invalidated: ReadonlyArray<ThreadId>;
    let deletedChildren: ReadonlyArray<ThreadId> = [];
    try {
      // Only the owner deletes; a member of a shared Thread cannot.
      const authorization = await Effect.runPromise(
        authorizeThreadRequest(threadId.value, principal, db),
      );
      if (authorization.authorized && authorization.access === "owner") {
        const family = [
          threadId.value,
          ...(includeChildren
            ? await listedChildThreadIds(
                db,
                threadId.value,
                ownerUserId,
                DELETE_THREAD_MAX_CHILDREN,
              )
            : []),
        ];
        // Children not deleted with it become top-level Threads.
        const detached = (await childThreadIds(db, family)).filter(
          (id) => !family.includes(id),
        );
        deletedAt = new Date().toISOString();
        const tombstoned = await tombstoneThreads(
          db,
          family,
          ownerUserId,
          deletedAt,
        );
        if (!tombstoned.includes(threadId.value))
          throw new Error("The Thread changed while it was being deleted.");
        deletedChildren = family.filter(
          (id) => id !== threadId.value && tombstoned.includes(id),
        );
        invalidated = [threadId.value, ...deletedChildren, ...detached];
        threadDeletionLogger.info("Thread deleted.", {
          event: "thread_deleted",
          requestId,
          threadId: threadId.value,
          deletedChildren: deletedChildren.length,
          detachedChildren: detached.length,
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
                ...(includeChildren ? { deletedChildThreadIds: [] } : {}),
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
    const cleanup = cleanupFor(context.env);
    const purge = (id: ThreadId) =>
      purgeDeletedThread(context.env, cleanup, id, ownerUserId).catch(
        (cause) => {
          threadDeletionLogger.warn("Thread cleanup could not be recorded.", {
            event: "thread_cleanup_unrecorded",
            threadId: id,
            cause,
          });
          return { complete: false };
        },
      );
    // A few at a time: each one calls its sandbox provider.
    const pending = [threadId.value, ...deletedChildren];
    const purged: Array<{ complete: boolean }> = [];
    await Promise.all(
      Array.from({ length: Math.min(4, pending.length) }, async () => {
        for (let id = pending.shift(); id !== undefined; id = pending.shift())
          purged.push(await purge(id));
      }),
    );
    return context.json(
      Schema.encodeUnknownSync(DeleteThreadResponseSchema)({
        status: "success",
        data: {
          threadId: threadId.value,
          deletedAt,
          cleanup: purged.every(({ complete }) => complete)
            ? "complete"
            : "pending",
          ...(includeChildren
            ? { deletedChildThreadIds: deletedChildren }
            : {}),
        },
      }),
      200,
    );
  });
  return routes;
};

export const threadDeletionRoutes = createThreadDeletionRoutes();
