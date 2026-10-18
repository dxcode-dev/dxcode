import type { Hono } from "hono";
import { authorizeThread } from "../auth/authorize-thread.js";
import { enforceThreadActive } from "../auth/enforce-thread-active.js";
import type { AppEnv } from "../http/types.js";
import { tracedMiddleware } from "../observability/boundaries.js";
import { submissionStartupObservation } from "../observability/submission-startup.js";
import { attributeSubmission } from "../thread-sharing/middleware.js";

const authorize = tracedMiddleware("agent.authorizeThread", authorizeThread);
const active = tracedMiddleware(
  "agent.enforceThreadActive",
  enforceThreadActive,
);
const attribute = tracedMiddleware(
  "agent.attributeSubmission",
  attributeSubmission,
);
const startup = tracedMiddleware(
  "agent.submissionStartup",
  submissionStartupObservation,
);

/**
 * dx's Thread admission in front of DxAgent's native Flue routes. Each
 * middleware is one `phase` span. Before a message is durable only
 * authentication, Thread access, lifecycle, and malformed input refuse it.
 * Source authority and workspace policy are checked when the run uses them
 * (`createSandbox`, `SourceRuntimeBroker`), so their failures are run errors
 * and the message is kept.
 */
export const useAgentAdmission = (routes: Hono<AppEnv>) => {
  routes.use("/:threadId", authorize);
  routes.use("/:threadId/:subpath{.+}", authorize);
  routes.use("/:threadId", active);
  routes.use("/:threadId/:subpath{.+}", active);
  routes.use("/:threadId", attribute);
  routes.use("/:threadId", startup);
  return routes;
};
