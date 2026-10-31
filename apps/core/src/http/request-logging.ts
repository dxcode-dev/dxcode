import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { requestLogger } from "../logging.js";
import type { AppEnv } from "./types.js";

const THREAD_PATH =
  /^\/v1\/(?:threads|agents\/dx)\/(thr_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})(?:\/|$)/;

// 1 on the first request an isolate serves: that request paid its cold start.
let isolateRequests = 0;
export const isolateRequestOrdinal = () => isolateRequests;

export const requestLogging: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  isolateRequests += 1;
  const isolateRequest = isolateRequests;
  const startedAt = performance.now();
  await next();

  const matchedPath = routePath(context, -1);
  // A Thread's requests name it, so its bug report can read their lines.
  const threadId = THREAD_PATH.exec(context.req.path)?.[1];
  requestLogger.info("Request completed.", {
    ...(threadId === undefined ? {} : { threadId }),
    event: "request_completed",
    requestId: context.get("requestId"),
    method: context.req.method,
    route:
      matchedPath === "*" || matchedPath === "/*" ? "<unmatched>" : matchedPath,
    status: context.res.status,
    durationMs: Math.round(performance.now() - startedAt),
    isolateRequest,
  });
};
