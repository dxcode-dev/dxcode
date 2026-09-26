import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./types.js";

const requestIdPattern = /^[A-Za-z0-9._-]{1,128}$/;

/**
 * Bounds caller-provided IDs so logs remain correlatable without accepting
 * arbitrary header content into operational telemetry.
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
  await next();
};
