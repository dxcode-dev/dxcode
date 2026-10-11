import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { authorizeThread } from "../auth/authorize-thread.js";
import { enforceAgentSourceAdmission } from "../auth/enforce-agent-source-admission.js";
import { enforceAgentWorkspacePolicy } from "../auth/enforce-agent-workspace-policy.js";
import { enforceThreadActive } from "../auth/enforce-thread-active.js";
import type { AppEnv } from "../http/types.js";
import { submissionStartupObservation } from "../observability/submission-startup.js";
import { attributeSubmission } from "../thread-sharing/middleware.js";
import { DxAgent } from "./dx-agent.js";

/**
 * DxAgent's native Flue routes behind dx's Thread admission, mounted at
 * `/v1/agents/dx` after authentication. The Thread tools send messages and
 * read history through these same routes as the Thread owner.
 */
export const dxAgentRoutes = new Hono<AppEnv>();
dxAgentRoutes.use("/:threadId", authorizeThread);
dxAgentRoutes.use("/:threadId/:subpath{.+}", authorizeThread);
dxAgentRoutes.use("/:threadId", enforceThreadActive);
dxAgentRoutes.use("/:threadId/:subpath{.+}", enforceThreadActive);
// Before source and policy checks, which a chat message skips.
dxAgentRoutes.use("/:threadId", attributeSubmission);
dxAgentRoutes.use("/:threadId", enforceAgentSourceAdmission);
dxAgentRoutes.use("/:threadId/:subpath{.+}", enforceAgentSourceAdmission);
dxAgentRoutes.use("/:threadId", enforceAgentWorkspacePolicy);
dxAgentRoutes.use("/:threadId/:subpath{.+}", enforceAgentWorkspacePolicy);
dxAgentRoutes.use("/:threadId", submissionStartupObservation);
dxAgentRoutes.route("/", createAgentRouter(DxAgent));
