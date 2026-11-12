import type { MiddlewareHandler } from "hono";
import { portalFeedbackService } from "../feedback-widget/portal-feedback.js";
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
  // Locally the Portal handler runs inside Core, so it calls Core's Feedback
  // Widget service directly instead of through the Portal Worker's binding.
  return handlePortalRequest(
    context.req.raw,
    {
      ...bindings,
      PORTAL_FEEDBACK: portalFeedbackService(bindings, (promise) =>
        context.executionCtx.waitUntil(promise),
      ),
    },
    configuration,
    match,
  );
};
