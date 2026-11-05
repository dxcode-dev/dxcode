import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import {
  apiPolicy,
  apiPolicyHeader,
  reportingEndpoints,
} from "./content-security-policy.mjs";

/**
 * Core's responses that set no policy of their own get `apiPolicy`. Static
 * documents never reach Core; the package's `_headers` file covers them.
 * Pages with their own policy (Portal pages, sandboxed files) keep theirs,
 * and WebSocket upgrades carry no document.
 */
export const contentSecurityPolicy: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  await next();
  const response = context.res;
  if (
    response.status === 101 ||
    response.headers.has("content-security-policy") ||
    response.headers.has("content-security-policy-report-only")
  )
    return;
  // A fetched or streamed response's headers may be immutable: copy it.
  const secured = new Response(response.body, response);
  secured.headers.set(apiPolicyHeader(), apiPolicy);
  secured.headers.set("reporting-endpoints", reportingEndpoints());
  context.res = secured;
};
