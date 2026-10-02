import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { requestLogger } from "../logging.js";
import type { AppEnv } from "./types.js";

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
  requestLogger.info("Request completed.", {
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
