import { Hono } from "hono";
import {
  dxAgentRoutes,
  rewindThreadAgent,
  stopThreadAgent,
} from "./agents/routes.js";
import { artifactLibraryRoutes } from "./artifact-library/routes.js";
import { LOCAL_R2_BUCKET, localR2Routes } from "./attachments/local-r2.js";
import { attachmentRoutes } from "./attachments/routes.js";
import { authenticate } from "./auth/authenticate.js";
import { authorizeApiTokenScope } from "./auth/authorize-api-token-scope.js";
import { authorizeThread } from "./auth/authorize-thread.js";
import { makeDeploymentAdminRoutes } from "./auth/deployment-admin.js";
import {
  registeredDeploymentAdminRoutes,
  registeredDeploymentHookRoutes,
  registeredDeploymentRoutes,
} from "./auth/deployment-admin-registration.js";
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
import { huddleLinkRoutes } from "./huddles/links.js";
import { threadHuddleRoutes } from "./huddles/routes.js";
import {
  notificationRoutes,
  notificationUnsubscribeRoutes,
} from "./notifications/routes.js";
import { installFlueObservation } from "./observability/flue.js";
import { installRuntimeTracing } from "./observability/platform-tracing.js";
import { threadOrbDiskRoutes } from "./orb-disk/routes.js";
import { threadOrbMemoryRoutes } from "./orb-memory/routes.js";
import { confirmMissesAtPrimary, d1Session } from "./persistence/d1-session.js";
import { pluginAgentRoutes } from "./plugins/agents/routes.js";
import { mcpAppViewRoutes } from "./plugins/code/mcp-apps-route.js";
import { pluginIconRoutes } from "./plugins/icons/routes.js";
import {
  pluginStreamProducerRoutes,
  pluginStreamViewerRoutes,
} from "./plugins/streams/lazy-routes.js";
import { pluginThreadUiRoutes } from "./plugins/thread-ui/routes.js";
import { pluginViewRoutes } from "./plugins/views/routes.js";
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
import { pageNotFound } from "./site/page-not-found.js";
import { bitbucketGitGatewayRoutes } from "./source-control/bitbucket/git-gateway.js";
import { bitbucketControlPlaneRoutes } from "./source-control/bitbucket/routes.js";
import {
  githubControlPlaneRoutes,
  githubWebhookRoutes,
} from "./source-control/github/routes.js";
import { messageCommentRoutes } from "./spaces/message-comments/routes.js";
import { spaceRoutes } from "./spaces/routes.js";
import { threadArtifactRoutes } from "./thread-artifacts/routes.js";
import { threadChangesRoutes } from "./thread-changes/routes.js";
import { threadDeletionRoutes } from "./thread-deletion/routes.js";
import { threadDesktopRoutes } from "./thread-desktop/routes.js";
import { threadFilesRoutes } from "./thread-files/routes.js";
import { threadSandboxFileRoutes } from "./thread-files/sandbox.js";
import { threadSearchRoutes } from "./thread-search/routes.js";
import { messageReactionRoutes } from "./thread-sharing/message-reactions.js";
import { shareThreadReads } from "./thread-sharing/middleware.js";
import {
  sharedThreadRoutes,
  threadMemberRoutes,
  threadSharingRoutes,
} from "./thread-sharing/routes.js";
import { threadStorageRoutes } from "./thread-storage/routes.js";
import { threadUsageRoutes } from "./thread-usage/routes.js";
import { threadDaemonRoutes } from "./threads/daemon-route.js";
import { createThreadMessageEditRoutes } from "./threads/message-edit-route.js";
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
// A deployment's own hooks that outside services call, signing each request
// themselves, so no session. Other /v1/deployment paths fall through to the
// signed-in routes below.
app.route("/v1/deployment", registeredDeploymentHookRoutes);
app.route("/v1", threadDaemonRoutes);
// Plugin icons by the hash of their bytes; see plugins/icons/routes.ts.
app.route("/v1/plugins/icons", pluginIconRoutes);
// Navigated to, not fetched: it redirects to sign-in instead of answering 401.
app.route("/v1/portal-auth", portalAuthRoutes);
// A plugin stream's producer, by its signed URL, no session.
app.route("/v1/plugin-streams", pluginStreamProducerRoutes);
app.use("/v1/*", authenticate);
app.use("/v1/*", authorizeApiTokenScope);
// The Artifacts library: every artifact the person may open.
app.route("/v1/artifacts", artifactLibraryRoutes);
app.route("/v1/attachments", attachmentRoutes);
app.route("/v1/avatars", avatarRoutes);
app.route("/v1/bug-reports", bugReportRoutes);
app.route(
  "/v1/deployment-admin",
  makeDeploymentAdminRoutes(registeredDeploymentAdminRoutes),
);
// A deployment's own routes for every signed-in person.
app.route("/v1/deployment", registeredDeploymentRoutes);
app.route("/v1/dictation", dictationRoutes);
// Where a huddle link opens, for the signed-in person.
app.route("/v1/huddle-links", huddleLinkRoutes);
app.route("/v1/invites", inviteAcceptRoutes);
app.route("/v1/notifications", notificationRoutes);
app.route("/v1/integrations/bitbucket", bitbucketControlPlaneRoutes);
app.route("/v1/integrations/github", githubControlPlaneRoutes);
app.route("/v1/plugin-agents", pluginAgentRoutes);
// Plugin pages and the caller's views catalog.
app.route("/v1/plugins/views", pluginViewRoutes);
app.route("/v1/projects", projectRoutes);
app.route("/v1/projects", projectRepositoryBrowseRoutes);
app.route("/v1/realtime", realtimeRoutes);
app.route("/v1/settings", settingsRoutes);
app.route("/v1/shared-threads", sharedThreadRoutes);
app.route("/v1/shell", shellRoutes);
app.route("/v1/sidebar-layout", sidebarLayoutRoutes);
app.route("/v1/spaces", spaceRoutes);
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
// A Space's message comments; `/message-comments/*` also matches the list.
app.use("/v1/threads/:threadId/message-comments/*", authorizeThread);
app.route("/v1/threads", messageCommentRoutes);
// Reactions on a shared Thread's messages; `/message-reactions/*` also
// matches the list.
app.use("/v1/threads/:threadId/message-reactions/*", authorizeThread);
app.route("/v1/threads", messageReactionRoutes);
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
// Cost & Usage; `/usage/*` also matches `/usage`. Whoever may open the
// Thread may read it.
app.use("/v1/threads/:threadId/usage/*", authorizeThread);
app.route("/v1/threads", threadUsageRoutes);
app.use("/v1/threads/:threadId/disk/*", authorizeThread);
app.route("/v1/threads", threadOrbDiskRoutes);
// The fault route below checks the access authorizeThread sets.
app.use("/v1/threads/:threadId/orb/*", authorizeThread);
// Branch previews only: reproduces slow Orb restores (#1956).
app.route("/v1/threads", threadOrbFaultRoutes);
// `/automations/*` also matches `/automations`; see Portals above.
app.use("/v1/threads/:threadId/automations/*", authorizeThread);
app.route("/v1/threads", threadAutomationRoutes);
// A person edits one of their earlier messages: the agent goes back to it.
app.use("/v1/threads/:threadId/messages/*", authorizeThread);
app.route(
  "/v1/threads",
  createThreadMessageEditRoutes({
    // Read at call time: worker tests replace the agent routes module.
    stop: (threadId, env) => stopThreadAgent(threadId, env),
    rewind: (threadId, input, env) => rewindThreadAgent(threadId, input, env),
    routes: async () => dxAgentRoutes,
  }),
);
// Installed plugins' prompts, notices, quick actions, and commands; the
// list is `/plugin-ui`, everything else is under it.
app.use("/v1/threads/:threadId/plugin-ui", authorizeThread);
app.use("/v1/threads/:threadId/plugin-ui/*", authorizeThread);
app.route("/v1/threads", pluginThreadUiRoutes);
// A pane's stream viewer and ICE servers, under /plugin-ui.
app.route("/v1/threads", pluginStreamViewerRoutes);
// A Thread's huddle, a Space's included, and its link: shared Threads only.
app.use("/v1/threads/:threadId/huddle", authorizeThread);
app.use("/v1/threads/:threadId/huddle/*", authorizeThread);
app.route("/v1/threads", threadHuddleRoutes);
app.use("/v1/threads/:threadId/quick-actions", authorizeThread);
app.route("/v1/threads", threadQuickActionsRoutes);
app.use("/v1/threads/:threadId/desktop/*", authorizeThread);
app.use("/v1/threads/:threadId/desktop/*", enforceThreadActive);
app.route("/v1/threads", threadDesktopRoutes);
// Per person, not per Thread: a member's panes never replace the owner's.
app.route("/v1/threads", threadPaneLayoutRoutes);
app.use("/v1/threads/:threadId/mcp-apps/*", authorizeThread);
app.route("/v1/threads", mcpAppViewRoutes);
// Per person too: each member of a shared Thread has their own draft.
app.route("/v1/threads", threadDraftRoutes);
app.route("/v1/agents/dx", dxAgentRoutes);

app.notFound(pageNotFound(notFoundHandler));
app.onError(errorHandler);
// A read a D1 replica answered "not found" is answered again at the primary.
app.fetch = confirmMissesAtPrimary(app.fetch) as typeof app.fetch;

export default app;
