import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import { handlePortalRequest } from "./handler.js";
import { matchPortalHost, portalConfiguration } from "./host.js";

/**
 * Sends a request addressed to a Portal host to the Portal handler before
 * any app route, request ID, or logging middleware sees it, so a guest's
 * response carries nothing of dx's. Without DX_PORTAL_DOMAIN it is a no-op.
 */
export const portalHostRouting: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const bindings = context.env ?? {};
  const configuration = portalConfiguration(bindings);
  const match =
    configuration === undefined
      ? undefined
      : matchPortalHost(new URL(context.req.url), configuration);
  if (configuration === undefined || match === undefined) return next();
  return handlePortalRequest(context.req.raw, bindings, configuration, match);
};
