import { OrbProviderRateLimitedResponseSchema } from "@dx/api";
import { Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { orbProvidersLogger } from "../logging.js";
import { takeRequestBudget } from "../security/request-budget.js";

/**
 * Saving an Orb provider connection checks the submitted credentials with
 * the provider, and the answer says whether they work. Without a limit any
 * signed-in person could test stolen Docker Hub passwords, or any provider's
 * keys, through dx's addresses (#2623). Each person gets this many saves an
 * hour, personal and workspace together: enough to fix a few typos.
 */
export const ORB_PROVIDER_CONNECTION_BUDGET = {
  maximum: 10,
  windowMs: 60 * 60 * 1000,
} as const;

/** Mounted on `PUT …/orb-providers/:providerId/connection`. */
export const limitOrbProviderConnectionSaves: MiddlewareHandler<
  AppEnv
> = async (context, next) => {
  const db = context.env.DB;
  // Without D1 the route answers that settings are unavailable.
  if (db === undefined) return next();
  const userId = context.get("principal").userId;
  if (
    await takeRequestBudget(
      db,
      `orb-provider-connection:${userId}`,
      ORB_PROVIDER_CONNECTION_BUDGET,
    )
  )
    return next();
  orbProvidersLogger.warn("Orb provider connection saves were rate limited.", {
    event: "orb_provider_connection_rate_limited",
    userId,
    provider: context.req.param("providerId"),
  });
  context.header("Retry-After", "3600");
  return context.json(
    Schema.encodeUnknownSync(OrbProviderRateLimitedResponseSchema)({
      status: "error",
      data: {
        code: "ORB_PROVIDER_RATE_LIMITED",
        message: "Too many Orb provider connection attempts. Try again later.",
        requestId: context.get("requestId"),
      },
    }),
    429,
  );
};
