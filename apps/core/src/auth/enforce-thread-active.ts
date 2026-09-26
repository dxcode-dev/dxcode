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
  const executionCapable =
    context.req.path === `/v1/threads/${threadId}/terminal` ||
    context.req.path.startsWith(`/v1/threads/${threadId}/files`) ||
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
