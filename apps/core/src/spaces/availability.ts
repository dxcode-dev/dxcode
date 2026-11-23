import type { ThreadNotFoundResponse } from "@dx/api";
import { ThreadId } from "@dx/domain";
import { Option, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";

/**
 * Spaces are a deploy-time choice: on unless the deployment bound
 * `DX_SPACES_ENABLED=false` (`spaces` in deploy.selfhost.json,
 * `DX_DEPLOYMENT_SPACES` for staging and previews). Off, Core refuses every
 * Space route and every request to a Space's own Thread, and runs no Space
 * work; the rows stay, so turning Spaces on again restores each Space.
 */
export const spacesEnabled = (
  bindings: Pick<Bindings, "DX_SPACES_ENABLED"> | undefined,
) => bindings?.DX_SPACES_ENABLED?.trim().toLowerCase() !== "false";

const SPACES_UNAVAILABLE_MESSAGE = "Spaces are off on this deployment.";

/** `/v1/spaces` and Space settings answer 404 while Spaces are off. */
export const requireSpaces: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  if (spacesEnabled(context.env)) return next();
  return context.json(
    {
      status: "error",
      data: {
        code: "SPACES_UNAVAILABLE",
        message: SPACES_UNAVAILABLE_MESSAGE,
        requestId: context.get("requestId"),
      },
    },
    404,
  );
};

/** Whether `threadId` is a Space's own Thread. */
export const isSpaceThread = async (db: D1Database, threadId: string) =>
  (await db
    .prepare("SELECT 1 AS found FROM threads WHERE id = ?1 AND kind = 'space'")
    .bind(threadId)
    .first<number>("found")) === 1;

/**
 * While Spaces are off, a Space's own Thread does not exist: its detail,
 * messages, agent, comments, and every other Thread route answer
 * `THREAD_NOT_FOUND`, so no person, schedule, or other Thread reaches its
 * agent. With Spaces on it reads nothing.
 */
export const hideSpaceThreads: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  if (spacesEnabled(context.env)) return next();
  const threadId = Option.getOrUndefined(
    Schema.decodeUnknownOption(ThreadId)(context.req.param("threadId")),
  );
  if (
    threadId === undefined ||
    context.env.DB === undefined ||
    !(await isSpaceThread(context.env.DB, threadId))
  )
    return next();
  return context.json<ThreadNotFoundResponse>(
    {
      status: "error",
      data: {
        code: "THREAD_NOT_FOUND",
        message: "Thread not found.",
        requestId: context.get("requestId"),
      },
    },
    404,
  );
};
