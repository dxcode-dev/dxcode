import { createAgentRouter } from "@flue/runtime/routing";
import { Hono } from "hono";
import { DxAgent } from "./agents/dx-agent.js";
import { authenticate } from "./auth/authenticate.js";
import { authorizeApiTokenScope } from "./auth/authorize-api-token-scope.js";
import { authorizeThread } from "./auth/authorize-thread.js";
import { enforceAgentSourceAdmission } from "./auth/enforce-agent-source-admission.js";
import { enforceAgentWorkspacePolicy } from "./auth/enforce-agent-workspace-policy.js";
import { enforceThreadActive } from "./auth/enforce-thread-active.js";
import { authRoutes } from "./auth/routes.js";
import { dictationRoutes } from "./dictation/routes.js";
import { healthHandler } from "./health/handler.js";
import { errorHandler, notFoundHandler } from "./http/http-errors.js";
import { requestId } from "./http/request-id.js";
import { requestLogging } from "./http/request-logging.js";
import type { AppEnv } from "./http/types.js";
import { installFlueObservation } from "./observability/flue.js";
import { submissionStartupObservation } from "./observability/submission-startup.js";
import { projectRoutes } from "./projects/routes.js";
import { readinessHandler } from "./readiness/handler.js";
import { realtimeRoutes } from "./realtime/realtime-hub.js";
import { settingsRoutes } from "./settings/routes.js";
import { pluginTriggerIngressRoutes } from "./settings/triggers/routes.js";
import { scheduleUsageRetention } from "./settings/usage/retention.js";
import { bitbucketGitGatewayRoutes } from "./source-control/bitbucket/git-gateway.js";
import { bitbucketControlPlaneRoutes } from "./source-control/bitbucket/routes.js";
import {
  githubControlPlaneRoutes,
  githubWebhookRoutes,
} from "./source-control/github/routes.js";
import { threadChangesRoutes } from "./thread-changes/routes.js";
import { threadFilesRoutes } from "./thread-files/routes.js";
import { threadSandboxFileRoutes } from "./thread-files/sandbox.js";
import { threadDaemonRoutes } from "./threads/daemon-route.js";
import { threadRoutes } from "./threads/routes.js";
import { threadTerminalRoutes } from "./threads/terminal-route.js";
import { workloadIdentityRoutes } from "./workload-identity/routes.js";

installFlueObservation();

const app = new Hono<AppEnv>();

app.use("*", requestId);
app.use("*", requestLogging);

app.get("/healthz", healthHandler);
app.get("/readyz", readinessHandler);

app.route("/api/auth", authRoutes);
app.route("/api/workload-identity", workloadIdentityRoutes);
app.route("/api/triggers", pluginTriggerIngressRoutes);
app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
app.route("/v1/integrations/github", githubWebhookRoutes);
app.route("/v1", threadDaemonRoutes);
app.use("/v1/*", authenticate);
app.use("/v1/*", authorizeApiTokenScope);
app.route("/v1/dictation", dictationRoutes);
app.route("/v1/integrations/bitbucket", bitbucketControlPlaneRoutes);
app.route("/v1/integrations/github", githubControlPlaneRoutes);
app.route("/v1/projects", projectRoutes);
app.route("/v1/realtime", realtimeRoutes);
app.route("/v1/settings", settingsRoutes);
app.route("/v1/threads", threadRoutes);
app.use("/v1/threads/:threadId/changes", authorizeThread);
app.use("/v1/threads/:threadId/changes/*", authorizeThread);
app.route("/v1/threads", threadChangesRoutes);
app.use("/v1/threads/:threadId/files", authorizeThread);
app.use("/v1/threads/:threadId/files/*", authorizeThread);
app.use("/v1/threads/:threadId/files", enforceThreadActive);
app.use("/v1/threads/:threadId/files/*", enforceThreadActive);
app.route("/v1/threads", threadFilesRoutes);
app.use("/v1/threads/:threadId/files-sandbox", authorizeThread);
app.use("/v1/threads/:threadId/files-sandbox", enforceThreadActive);
app.route("/v1/threads", threadSandboxFileRoutes);
app.use("/v1/threads/:threadId/terminal", authorizeThread);
app.use("/v1/threads/:threadId/terminal", enforceThreadActive);
app.route("/v1/threads", threadTerminalRoutes);
app.use("/v1/agents/dx/:threadId", authorizeThread);
app.use("/v1/agents/dx/:threadId/:subpath{.+}", authorizeThread);
app.use("/v1/agents/dx/:threadId", enforceThreadActive);
app.use("/v1/agents/dx/:threadId/:subpath{.+}", enforceThreadActive);
app.use("/v1/agents/dx/:threadId", enforceAgentSourceAdmission);
app.use("/v1/agents/dx/:threadId/:subpath{.+}", enforceAgentSourceAdmission);
app.use("/v1/agents/dx/:threadId", enforceAgentWorkspacePolicy);
app.use("/v1/agents/dx/:threadId/:subpath{.+}", enforceAgentWorkspacePolicy);
app.use("/v1/agents/dx/:threadId", submissionStartupObservation);
app.route("/v1/agents/dx", createAgentRouter(DxAgent));

app.notFound(notFoundHandler);
app.onError(errorHandler);

export default Object.assign(app, { scheduled: scheduleUsageRetention });
