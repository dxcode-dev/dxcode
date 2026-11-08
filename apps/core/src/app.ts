import { Hono } from "hono";
import { dxAgentRoutes } from "./agents/routes.js";
import { LOCAL_R2_BUCKET, localR2Routes } from "./attachments/local-r2.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { authenticate } from "./auth/authenticate.js";
import { authorizeApiTokenScope } from "./auth/authorize-api-token-scope.js";
import { authorizeThread } from "./auth/authorize-thread.js";
import { enforceThreadActive } from "./auth/enforce-thread-active.js";
import { authRoutes } from "./auth/routes.js";
import { threadAutomationRoutes } from "./automations/routes.js";
import { avatarRoutes } from "./avatars/routes.js";
import { bugReportIntakeRoutes } from "./bug-reports/intake.js";
import {
  bugReportRoutes,
  threadBugReportRoutes,
} from "./bug-reports/routes.js";
import { dictationRoutes } from "./dictation/routes.js";
import { threadOrbFaultRoutes } from "./execution/cloudflare/orb-fault-route.js";
import { feedbackWidgetPublicRoutes } from "./feedback-widget/public-routes.js";
import { healthHandler } from "./health/handler.js";
import { errorHandler, notFoundHandler } from "./http/http-errors.js";
import { requestId } from "./http/request-id.js";
import { requestLogging } from "./http/request-logging.js";
import type { AppEnv } from "./http/types.js";
import {
  notificationRoutes,
  notificationUnsubscribeRoutes,
} from "./notifications/routes.js";
import { installFlueObservation } from "./observability/flue.js";
import { installRuntimeTracing } from "./observability/platform-tracing.js";
import { threadOrbDiskRoutes } from "./orb-disk/routes.js";
import { threadOrbMemoryRoutes } from "./orb-memory/routes.js";
import { confirmMissesAtPrimary, d1Session } from "./persistence/d1-session.js";
import { portalAuthRoutes } from "./portals/auth-routes.js";
import { portalHostRouting } from "./portals/host-routing.js";
import { threadPortalRoutes } from "./portals/routes.js";
import { projectRepositoryBrowseRoutes } from "./projects/repository-browse.js";
import { projectRoutes } from "./projects/routes.js";
import { threadQuickActionsRoutes } from "./quick-actions/routes.js";
import { readinessHandler } from "./readiness/handler.js";
import { realtimeRoutes } from "./realtime/realtime-hub.js";
import { contentSecurityPolicy } from "./security/headers.js";
import { cspReportRoutes } from "./security/reports.js";
import {
  inviteAcceptRoutes,
  publicInviteRoutes,
} from "./settings/members/routes.js";
import { settingsRoutes } from "./settings/routes.js";
import { pluginTriggerIngressRoutes } from "./settings/triggers/routes.js";
import { shellRoutes } from "./shell/routes.js";
import { sidebarLayoutRoutes } from "./sidebar-layout/routes.js";
import { bitbucketGitGatewayRoutes } from "./source-control/bitbucket/git-gateway.js";
import { bitbucketControlPlaneRoutes } from "./source-control/bitbucket/routes.js";
import {
  githubControlPlaneRoutes,
  githubWebhookRoutes,
} from "./source-control/github/routes.js";
import { threadArtifactRoutes } from "./thread-artifacts/routes.js";
import { threadChangesRoutes } from "./thread-changes/routes.js";
import { threadDeletionRoutes } from "./thread-deletion/routes.js";
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
import { threadStorageRoutes } from "./thread-storage/routes.js";
import { threadDaemonRoutes } from "./threads/daemon-route.js";
import { threadPaneLayoutRoutes } from "./threads/pane-layout-route.js";
import { threadRoutes } from "./threads/routes.js";
import { threadTerminalRoutes } from "./threads/terminal-route.js";
import { threadDraftRoutes } from "./threads/thread-draft-route.js";
import { workloadIdentityRoutes } from "./workload-identity/routes.js";

installRuntimeTracing();
installFlueObservation();

const app = new Hono<AppEnv>();

app.use("*", portalHostRouting);
app.use("*", requestId);
app.use("*", requestLogging);
app.use("*", d1Session);
app.use("*", contentSecurityPolicy);

app.get("/healthz", healthHandler);
app.get("/readyz", readinessHandler);
// Local development only: its emulation of R2's S3 API for attachments.
app.route(`/${LOCAL_R2_BUCKET}`, localR2Routes);

app.route("/api/auth", authRoutes);
app.route("/api/csp-reports", cspReportRoutes);
app.route("/api/workload-identity", workloadIdentityRoutes);
app.route("/api/triggers", pluginTriggerIngressRoutes);
app.route("/api/invites", publicInviteRoutes);
// Other deployments forward bug reports here with an intake key, not a session.
app.route("/api/bug-reports", bugReportIntakeRoutes);
app.route("/api/notifications/unsubscribe", notificationUnsubscribeRoutes);
// Websites embed the Feedback Widget; its panel signs in with its own grant.
app.route("/api/feedback-widget", feedbackWidgetPublicRoutes);
app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
app.route("/v1/integrations/github", githubWebhookRoutes);
app.route("/v1", threadDaemonRoutes);
// Navigated to, not fetched: it redirects to sign-in instead of answering 401.
app.route("/v1/portal-auth", portalAuthRoutes);
app.use("/v1/*", authenticate);
app.use("/v1/*", authorizeApiTokenScope);
app.route("/v1/attachments", attachmentRoutes);
app.route("/v1/avatars", avatarRoutes);
app.route("/v1/bug-reports", bugReportRoutes);
app.route("/v1/dictation", dictationRoutes);
app.route("/v1/invites", inviteAcceptRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/integrations/bitbucket", bitbucketControlPlaneRoutes);
app.route("/v1/integrations/github", githubControlPlaneRoutes);
app.route("/v1/projects", projectRoutes);
app.route("/v1/projects", projectRepositoryBrowseRoutes);
app.route("/v1/realtime", realtimeRoutes);
app.route("/v1/settings", settingsRoutes);
app.route("/v1/shared-threads", sharedThreadRoutes);
app.route("/v1/shell", shellRoutes);
app.route("/v1/sidebar-layout", sidebarLayoutRoutes);
app.route("/v1/thread-search", threadSearchRoutes);
app.use("/v1/threads/:threadId", shareThreadReads);
app.use("/v1/threads/:threadId/readiness", shareThreadReads);
app.route("/v1/threads", threadRoutes);
app.route("/v1/threads", threadDeletionRoutes);
app.route("/v1/threads", threadSharingRoutes);
app.use("/v1/threads/:threadId/members", authorizeThread);
app.use("/v1/threads/:threadId/follow", authorizeThread);
app.route("/v1/threads", threadMemberRoutes);
app.use("/v1/threads/:threadId/bug-reports", authorizeThread);
app.route("/v1/threads", threadBugReportRoutes);
// `/changes/*` also matches `/changes`, and `/files/*` `/files`; registering
// both would authorize twice, one more D1 round trip per request.
app.use("/v1/threads/:threadId/changes/*", authorizeThread);
app.route("/v1/threads", threadChangesRoutes);
app.use("/v1/threads/:threadId/files/*", authorizeThread);
app.use("/v1/threads/:threadId/files/*", enforceThreadActive);
app.route("/v1/threads", threadFilesRoutes);
app.use("/v1/threads/:threadId/files-sandbox", authorizeThread);
app.use("/v1/threads/:threadId/files-sandbox", enforceThreadActive);
app.route("/v1/threads", threadSandboxFileRoutes);
// Not `enforceThreadActive`: stored files outlive the Orb and stay readable
// while the Thread is archived. `/storage/*` also matches `/storage`.
app.use("/v1/threads/:threadId/storage/*", authorizeThread);
app.route("/v1/threads", threadStorageRoutes);
// Artifacts outlive the Orb too. `/artifacts/*` also matches `/artifacts`.
app.use("/v1/threads/:threadId/artifacts/*", authorizeThread);
app.route("/v1/threads", threadArtifactRoutes);
// `/terminal/*` also matches `/terminal`: the attach and its warm-up.
app.use("/v1/threads/:threadId/terminal/*", authorizeThread);
app.use("/v1/threads/:threadId/terminal/*", enforceThreadActive);
app.route("/v1/threads", threadTerminalRoutes);
// `/portals/*` also matches `/portals`; authorizing twice would see the
// owner a contributor is impersonating.
app.use("/v1/threads/:threadId/portals/*", authorizeThread);
app.route("/v1/threads", threadPortalRoutes);
// `/memory/*` also matches `/memory`; see Portals above.
app.use("/v1/threads/:threadId/memory/*", authorizeThread);
app.route("/v1/threads", threadOrbMemoryRoutes);
app.use("/v1/threads/:threadId/disk/*", authorizeThread);
app.route("/v1/threads", threadOrbDiskRoutes);
// The fault route below checks the access authorizeThread sets.
app.use("/v1/threads/:threadId/orb/*", authorizeThread);
// Branch previews only: reproduces slow Orb restores (#1956).
app.route("/v1/threads", threadOrbFaultRoutes);
// `/automations/*` also matches `/automations`; see Portals above.
app.use("/v1/threads/:threadId/automations/*", authorizeThread);
app.route("/v1/threads", threadAutomationRoutes);
app.use("/v1/threads/:threadId/quick-actions", authorizeThread);
app.route("/v1/threads", threadQuickActionsRoutes);
app.use("/v1/threads/:threadId/desktop/*", authorizeThread);
app.use("/v1/threads/:threadId/desktop/*", enforceThreadActive);
app.route("/v1/threads", threadDesktopRoutes);
// Per person, not per Thread: a member's panes never replace the owner's.
app.route("/v1/threads", threadPaneLayoutRoutes);
// Per person too: each member of a shared Thread has their own draft.
app.route("/v1/threads", threadDraftRoutes);
app.route("/v1/agents/dx", dxAgentRoutes);

app.notFound(notFoundHandler);
app.onError(errorHandler);
// A read a D1 replica answered "not found" is answered again at the primary.
app.fetch = confirmMissesAtPrimary(app.fetch) as typeof app.fetch;

export default app;
