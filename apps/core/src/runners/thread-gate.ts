import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";

/** Whether the Thread runs on a person's own machine. */
export const isRunnerThread = async (
  db: D1Database,
  threadId: string,
): Promise<boolean> =>
  (await db
    .prepare(
      `SELECT 1 AS runner FROM execution_workspace
        WHERE thread_id = ? AND provider = 'runner'`,
    )
    .bind(threadId)
    .first()) !== null;

/**
 * A runner Thread's Terminal is a shell on its owner's own machine, and its
 * Desktop shows and controls that whole machine, so only the owner opens
 * them, even when the Thread is shared; collaborators keep the transcript,
 * Files, Changes, and Portals. Runs after `authorizeThread`.
 */
const ownerOnlyOnRunnerFor =
  (feature: "Terminal" | "Desktop"): MiddlewareHandler<AppEnv> =>
  async (context, next) => {
    const db = context.env.DB;
    const threadId = context.req.param("threadId");
    if (
      db !== undefined &&
      threadId !== undefined &&
      context.get("threadAccess") !== "owner" &&
      (await isRunnerThread(db, threadId))
    ) {
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          status: "error",
          data: {
            code: "RUNNER_THREAD_OWNER_ONLY",
            message: `Only the Thread's owner opens the ${feature} of a Thread on their own machine.`,
            requestId: context.get("requestId"),
          },
        },
        403,
      );
    }
    await next();
  };

export const ownerOnlyOnRunner = ownerOnlyOnRunnerFor("Terminal");
export const desktopOwnerOnlyOnRunner = ownerOnlyOnRunnerFor("Desktop");
