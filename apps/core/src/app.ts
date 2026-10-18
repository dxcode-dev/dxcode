import { Hono } from "hono";
import { dxAgentRoutes } from "./agents/routes.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { purgeUnsentAttachments } from "./attachments/store.js";
import { attachmentTransfer } from "./attachments/transfer.js";
import { authenticate } from "./auth/authenticate.js";
import { authorizeApiTokenScope } from "./auth/authorize-api-token-scope.js";
import { authorizeThread } from "./auth/authorize-thread.js";
import { enforceThreadActive } from "./auth/enforce-thread-active.js";
import { authRoutes } from "./auth/routes.js";
import { dictationRoutes } from "./dictation/routes.js";
import { healthHandler } from "./health/handler.js";
import { errorHandler, notFoundHandler } from "./http/http-errors.js";
import { requestId } from "./http/request-id.js";
import { requestLogging } from "./http/request-logging.js";
import type { AppEnv } from "./http/types.js";
import { attachmentLogger } from "./logging.js";
import {
  notificationRoutes,
  notificationUnsubscribeRoutes,
} from "./notifications/routes.js";
import { installFlueObservation } from "./observability/flue.js";
import { installRuntimeTracing } from "./observability/platform-tracing.js";
import { portalAuthRoutes } from "./portals/auth-routes.js";
import { portalHostRouting } from "./portals/host-routing.js";
import { threadPortalRoutes } from "./portals/routes.js";
import { projectRoutes } from "./projects/routes.js";
import { readinessHandler } from "./readiness/handler.js";
import { realtimeRoutes } from "./realtime/realtime-hub.js";
import {
  inviteAcceptRoutes,
  publicInviteRoutes,
} from "./settings/members/routes.js";
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
import { threadDesktopRoutes } from "./thread-desktop/routes.js";
import { threadFilesRoutes } from "./thread-files/routes.js";
import { threadSandboxFileRoutes } from "./thread-files/sandbox.js";
import { threadSearchRoutes } from "./thread-search/routes.js";
import { shareThreadReads } from "./thread-sharing/middleware.js";
import {
  sharedThreadRoutes,
  threadMemberRoutes,
  threadSharingRoutes,
} from "./thread-sharing/routes.js";
import { threadDaemonRoutes } from "./threads/daemon-route.js";
import { threadRoutes } from "./threads/routes.js";
import { threadTerminalRoutes } from "./threads/terminal-route.js";
import { workloadIdentityRoutes } from "./workload-identity/routes.js";

installRuntimeTracing();
installFlueObservation();

const app = new Hono<AppEnv>();

app.use("*", portalHostRouting);
app.use("*", requestId);
app.use("*", requestLogging);

app.get("/healthz", healthHandler);
app.get("/readyz", readinessHandler);

app.route("/api/auth", authRoutes);
app.route("/api/workload-identity", workloadIdentityRoutes);
app.route("/api/triggers", pluginTriggerIngressRoutes);
app.route("/api/invites", publicInviteRoutes);
app.route("/api/notifications/unsubscribe", notificationUnsubscribeRoutes);
app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
app.route("/v1/integrations/github", githubWebhookRoutes);
app.route("/v1", threadDaemonRoutes);
// Navigated to, not fetched: it redirects to sign-in instead of answering 401.
app.route("/v1/portal-auth", portalAuthRoutes);
app.use("/v1/*", authenticate);
app.use("/v1/*", authorizeApiTokenScope);
app.route("/v1/attachments", attachmentRoutes);
app.route("/v1/dictation", dictationRoutes);
app.route("/v1/invites", inviteAcceptRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/integrations/bitbucket", bitbucketControlPlaneRoutes);
app.route("/v1/integrations/github", githubControlPlaneRoutes);
app.route("/v1/projects", projectRoutes);
app.route("/v1/realtime", realtimeRoutes);
app.route("/v1/settings", settingsRoutes);
app.route("/v1/shared-threads", sharedThreadRoutes);
app.route("/v1/thread-search", threadSearchRoutes);
app.use("/v1/threads/:threadId", shareThreadReads);
app.use("/v1/threads/:threadId/readiness", shareThreadReads);
app.route("/v1/threads", threadRoutes);
app.route("/v1/threads", threadSharingRoutes);
app.use("/v1/threads/:threadId/members", authorizeThread);
app.use("/v1/threads/:threadId/follow", authorizeThread);
app.route("/v1/threads", threadMemberRoutes);
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
// `/portals/*` also matches `/portals`; authorizing twice would see the
// owner a contributor is impersonating.
app.use("/v1/threads/:threadId/portals/*", authorizeThread);
app.route("/v1/threads", threadPortalRoutes);
app.use("/v1/threads/:threadId/desktop/*", authorizeThread);
app.use("/v1/threads/:threadId/desktop/*", enforceThreadActive);
app.route("/v1/threads", threadDesktopRoutes);
app.route("/v1/agents/dx", dxAgentRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);

export default Object.assign(app, {
  scheduled: (
    controller: ScheduledController,
    bindings: AppEnv["Bindings"],
    context: ExecutionContext,
  ) => {
    scheduleUsageRetention(controller, bindings, context);
    const transfer = attachmentTransfer(bindings);
    if (transfer === undefined) return;
    context.waitUntil(
      purgeUnsentAttachments(bindings, transfer, controller.scheduledTime, {
        limit: 500,
      })
        .then((deleted) =>
          attachmentLogger.info("Unsent attachments purged.", {
            event: "attachment_retention_completed",
            deleted,
          }),
        )
        .catch(() =>
          attachmentLogger.error("Unsent attachment retention failed.", {
            event: "attachment_retention_failed",
          }),
        ),
    );
  },
});
