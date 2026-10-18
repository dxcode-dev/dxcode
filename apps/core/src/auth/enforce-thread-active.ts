import { ThreadArchivedResponseSchema } from "@dx/api";
import { Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";

export const enforceThreadActive: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const threadId = context.req.param("threadId") ?? "";
  const agentPath = `/v1/agents/dx/${threadId}`;
  const threadPath = `/v1/threads/${threadId}`;
  // Each of these wakes the workspace or runs something in it; the Desktop
  // (its status check and sockets) also starts the desktop session.
  const executionCapable =
    context.req.path === `${threadPath}/terminal` ||
    context.req.path.startsWith(`${threadPath}/files`) ||
    context.req.path === `${threadPath}/desktop` ||
    context.req.path.startsWith(`${threadPath}/desktop/`) ||
    (context.req.method === "POST" &&
      [agentPath, `${agentPath}/abort`].includes(context.req.path));
  if (executionCapable && context.get("threadLifecycleState") === "archived")
    return context.json(
      Schema.encodeUnknownSync(ThreadArchivedResponseSchema)({
        status: "error",
        data: {
          code: "THREAD_ARCHIVED",
          message: "Thread is archived. Unarchive it before continuing.",
          requestId: context.get("requestId"),
        },
      }),
      409,
    );
  await next();
};
