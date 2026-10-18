import type { MiddlewareHandler } from "hono";
import { routePath } from "hono/route";
import { observeCall } from "../observability/tracing.js";
import type { AppEnv } from "./types.js";

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Bounds caller-provided IDs so logs remain correlatable without accepting
 * arbitrary header content into operational telemetry. The request's root
 * span carries the same ID and, once routed, the route template.
 */
export const requestId: MiddlewareHandler<AppEnv> = async (context, next) => {
  context.set("requestStartedAt", Date.now());
  const candidate = context.req.header("x-request-id");
  const value =
    candidate !== undefined && requestIdPattern.test(candidate)
      ? candidate
      : crypto.randomUUID();

  context.set("requestId", value);
  context.header("x-request-id", value);
  await observeCall(
    "http.request",
    "request",
    { "dx.request_id": value, "http.request.method": context.req.method },
    async (span) => {
      try {
        await next();
      } finally {
        const matchedPath = routePath(context, -1);
        span?.attribute(
          "http.route",
          matchedPath === "*" || matchedPath === "/*"
            ? "<unmatched>"
            : matchedPath,
        );
        span?.attribute("http.response.status_code", context.res.status);
      }
    },
  );
};
