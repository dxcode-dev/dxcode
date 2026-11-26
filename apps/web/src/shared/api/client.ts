import {
  AcceptWorkspaceInviteResponseSchema,
  ArchiveThreadInvalidRequestResponseSchema,
  ArchiveThreadNotFoundResponseSchema,
  ArchiveThreadPersistenceUnavailableResponseSchema,
  ArchiveThreadProjectDeletedResponseSchema,
  ArchiveThreadResponseSchema,
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  CatalogResponseSchema,
  ChoicesResponseSchema,
  type ConnectionData,
  ConnectionResponseSchema,
  type CreateConnectionRequestSchema,
  type CreateExternalApiApplicationRequest,
  CreateExternalApiApplicationResponseSchema,
  CreatePluginTriggerResponseSchema,
  CreateProjectForbiddenResponseSchema,
  CreateProjectInvalidRequestResponseSchema,
  CreateProjectNameConflictResponseSchema,
  CreateProjectPersistenceUnavailableResponseSchema,
  CreateProjectPolicyDeniedResponseSchema,
  type CreateProjectRequestSchema,
  CreateProjectRunnerUnavailableResponseSchema,
  CreateThreadAlreadyStartedResponseSchema,
  CreateThreadClaudePlanRefusedResponseSchema,
  CreateThreadInitialAdmissionUnavailableResponseSchema,
  CreateThreadInitialMessageRejectedResponseSchema,
  CreateThreadInitialMessageTooLargeResponseSchema,
  CreateThreadInitialSubmissionConflictResponseSchema,
  CreateThreadInvalidRequestResponseSchema,
  CreateThreadModelRouteUnavailableResponseSchema,
  CreateThreadOrbUnavailableResponseSchema,
  CreateThreadPersistenceUnavailableResponseSchema,
  CreateThreadPolicyDeniedResponseSchema,
  CreateThreadProjectlessForbiddenResponseSchema,
  CreateThreadProjectNotFoundResponseSchema,
  CreateThreadRunnerUnavailableResponseSchema,
  type CreateWorkspaceInviteLinkRequest,
  DeleteConnectionResponseSchema,
  DeleteProjectInvalidRequestResponseSchema,
  DeleteProjectNameMismatchResponseSchema,
  DeleteProjectNotFoundResponseSchema,
  DeleteProjectPersistenceUnavailableResponseSchema,
  DeleteThreadInvalidRequestResponseSchema,
  DeleteThreadNotFoundResponseSchema,
  DeleteThreadPersistenceUnavailableResponseSchema,
  DeleteThreadResponseSchema,
  type DeleteWorkspaceRequest,
  DeleteWorkspaceResponseSchema,
  DisconnectPersonalModelSubscriptionResponseSchema,
  type ExternalApiApplicationAuditEventData,
  type ExternalApiApplicationData,
  ExternalApiApplicationsErrorResponseSchema,
  GetSidebarLayoutEndpoint,
  GetSpaceAgentModelResponseSchema,
  GetThreadDraftEndpoint,
  GetThreadListItemResponseSchema,
  GetThreadMembersResponseSchema,
  GetThreadPaneLayoutEndpoint,
  GetThreadReadinessResponseSchema,
  GetThreadResponseSchema,
  GetWorkspaceDraftEndpoint,
  GraphResponseSchema,
  IntegrationsErrorResponseSchema,
  LeaveWorkspaceResponseSchema,
  ListConnectionsResponseSchema,
  ListExternalApiApplicationAuditResponseSchema,
  ListExternalApiApplicationsResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
  ListPluginTriggersResponseSchema,
  ListSharedThreadsResponseSchema,
  ListThreadsResponseSchema,
  ListWorkspaceInviteLinksResponseSchema,
  ListWorkspaceMembersResponseSchema,
  MarkThreadSeenEndpoint,
  ModelRoutingErrorResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
  PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  PersonalModelSubscriptionInUseResponseSchema,
  PersonalModelSubscriptionNotFoundResponseSchema,
  PersonalModelSubscriptionUnavailableResponseSchema,
  PinThreadEndpoint,
  PluginBundlesErrorResponseSchema,
  PluginTriggersErrorResponseSchema,
  PollPersonalModelSubscriptionAuthorizationResponseSchema,
  ProfileResponseSchema,
  type ProjectData,
  ProjectIconNotImageResponseSchema,
  ProjectIconTooLargeResponseSchema,
  ProjectOrbScriptsForbiddenResponseSchema,
  type PutModeRequestSchema,
  RefreshPersonalModelSubscriptionResponseSchema,
  RemoveWorkspaceMemberResponseSchema,
  type ReorderConnectionsRequestSchema,
  ReorderConnectionsResponseSchema,
  RetryInitialDispatchResponseSchema,
  RetryPluginTriggerDeliveryResponseSchema,
  RevokeExternalApiApplicationResponseSchema,
  RevokePluginTriggerResponseSchema,
  RevokeWorkspaceInviteLinkResponseSchema,
  RotateExternalApiApplicationResponseSchema,
  RotatePluginTriggerResponseSchema,
  SearchThreadsEndpoint,
  type SearchThreadsItem,
  type SetClaudePlanRequestSchema,
  type SetConnectionEnabledRequestSchema,
  SetExternalApiApplicationStatusResponseSchema,
  type SidebarLayoutChoice,
  SkillsErrorResponseSchema,
  SnoozeThreadEndpoint,
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
  SpaceErrorResponseSchema,
  type ThreadData,
  ThreadDeletedResponseSchema,
  type ThreadDetailData,
  type ThreadDraftSlot,
  ThreadFollowResponseSchema,
  ThreadIdUnavailableResponseSchema,
  type ThreadListItem,
  type ThreadPaneLayout,
  ThreadSharingErrorResponseSchema,
  type UpdateConnectionRequestSchema,
  type UpdateExternalApiApplicationRequest,
  UpdateExternalApiApplicationResponseSchema,
  UpdatePluginTriggerStateResponseSchema,
  UpdateProjectNameConflictResponseSchema,
  UpdateSidebarLayoutEndpoint,
  type UpdateSpaceAgentModelRequestSchema,
  UpdateThreadDraftEndpoint,
  UpdateThreadPaneLayoutEndpoint,
  type UpdateThreadRequest,
  UpdateThreadResponseSchema,
  type UpdateThreadSharingRequest,
  UpdateThreadSharingResponseSchema,
  UpdateWorkspaceDraftEndpoint,
  type WorkspaceDraftSlot,
  WorkspaceInviteLinkResponseSchema,
  WorkspaceInvitePreviewResponseSchema,
  WorkspaceMemberResponseSchema,
  WorkspaceMembersErrorResponseSchema,
  WorkspacePolicyErrorResponseSchema,
} from "@dx/api";
import { ApiError, createDxClient } from "@dx/client";
import type {
  EnvironmentVariableConfigReference,
  ExternalApiApplicationId,
  ExternalApiApplicationRotationOverlapSeconds,
  PageCursor,
  PluginId,
  PluginTriggerDeliveryId,
  PluginTriggerId,
  PluginVersion,
  ProjectId,
  ThreadId,
  WorkspacePermission,
  WorkspaceSlug,
} from "@dx/domain";
import { DateTime, Schema } from "effect";
import { noticeUnauthenticated } from "../auth/session-ended.js";
import { observeRequest } from "../diagnostics/client-diagnostics.js";
import { takeBootRead } from "../same-origin-fetch.js";

export { ApiError };

/**
 * The web's dx client: same-origin cookies, the boot's prefetched reads, and
 * request diagnostics. Call endpoints from `@dx/api` with it instead of
 * writing a `/v1/` path here (wiki/headless-client.md).
 */
export const dxClient = createDxClient({
  takePrefetched: takeBootRead,
  fetch: async (path, init) => {
    const response = await observeRequest(path, init.method, () =>
      fetch(path, { ...init, credentials: "same-origin" }),
    );
    noticeUnauthenticated(response);
    return response;
  },
});

/** A feature's own error answers, which `request` reads before the shared ones. */
type RefusalSchema = Schema.ConstraintDecoder<{
  readonly data: { readonly code: string; readonly message: string };
}>;

/**
 * A dx route that answers with a file, such as a plugin export: its bytes,
 * or an ApiError carrying the route's refusal message.
 */
export const requestBlob = async (
  path: string,
  init?: RequestInit,
): Promise<Blob> => {
  const response = await observeRequest(path, init?.method, () =>
    fetch(path, { ...init, credentials: "same-origin" }),
  );
  noticeUnauthenticated(response);
  if (!response.ok) {
    const body = (await response.json().catch(() => undefined)) as
      | { data?: { message?: unknown; code?: unknown } }
      | undefined;
    throw new ApiError(
      response.status,
      typeof body?.data?.message === "string"
        ? body.data.message
        : "Request failed.",
      typeof body?.data?.code === "string" ? body.data.code : undefined,
    );
  }
  return response.blob();
};

export const request = async <
  SchemaType extends Schema.ConstraintDecoder<unknown>,
>(
  path: string,
  schema: SchemaType,
  init?: RequestInit,
  /**
   * The route's own errors, for a feature that loads its schemas lazily
   * instead of adding them to the shared list below.
   */
  refusals?: RefusalSchema,
): Promise<SchemaType["Type"]> => {
  // The first read of a boot path takes the answer read at boot; one that
  // does not decode is read again. A 404 read at boot is the answer too:
  // the Thread is not there, and reading it again only delays saying so.
  let bootNotFound: Response | undefined;
  if ((init?.method ?? "GET") === "GET") {
    const prefetched = await takeBootRead(path);
    if (prefetched?.status === 200) {
      const decoded = await Schema.decodeUnknownPromise(schema)(
        JSON.parse(prefetched.text),
      ).then(
        (value) => ({ value }),
        () => undefined,
      );
      if (decoded !== undefined) return decoded.value;
    }
    if (prefetched?.status === 404)
      bootNotFound = new Response(prefetched.text, {
        status: 404,
        headers: { "content-type": prefetched.contentType },
      });
  }
  const response =
    bootNotFound ??
    (await observeRequest(path, init?.method, () =>
      fetch(path, {
        ...init,
        credentials: "same-origin",
        headers: {
          accept: "application/json",
          ...(init?.body === undefined
            ? {}
            : { "content-type": "application/json" }),
          ...init?.headers,
        },
      }),
    ));
  noticeUnauthenticated(response);
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const refusal =
      refusals === undefined
        ? undefined
        : await Schema.decodeUnknownPromise(refusals)(body).catch(
            () => undefined,
          );
    if (refusal !== undefined)
      throw new ApiError(
        response.status,
        refusal.data.message,
        refusal.data.code,
        undefined,
        undefined,
        true,
        refusal.data,
      );
    const settingsError = await Schema.decodeUnknownPromise(
      Schema.Union([
        // Deployment admin's username reset sends it.
        PersonalAccountPersistenceUnavailableResponseSchema,
        WorkspaceMembersErrorResponseSchema,
        // Skill routes send it too.
        WorkspacePolicyErrorResponseSchema,
        ExternalApiApplicationsErrorResponseSchema,
        ModelRoutingErrorResponseSchema,
        PersonalModelSubscriptionNotFoundResponseSchema,
        PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
        PersonalModelSubscriptionInUseResponseSchema,
        PersonalModelSubscriptionUnavailableResponseSchema,
        SkillsErrorResponseSchema,
        PluginBundlesErrorResponseSchema,
        IntegrationsErrorResponseSchema,
        PluginTriggersErrorResponseSchema,
        CreateProjectInvalidRequestResponseSchema,
        CreateProjectNameConflictResponseSchema,
        CreateProjectPersistenceUnavailableResponseSchema,
        CreateProjectForbiddenResponseSchema,
        CreateProjectPolicyDeniedResponseSchema,
        CreateProjectRunnerUnavailableResponseSchema,
        UpdateProjectNameConflictResponseSchema,
        ProjectIconNotImageResponseSchema,
        ProjectIconTooLargeResponseSchema,
        ProjectOrbScriptsForbiddenResponseSchema,
        CreateThreadInitialAdmissionUnavailableResponseSchema,
        CreateThreadInitialMessageRejectedResponseSchema,
        CreateThreadInitialMessageTooLargeResponseSchema,
        CreateThreadInitialSubmissionConflictResponseSchema,
        CreateThreadAlreadyStartedResponseSchema,
        CreateThreadInvalidRequestResponseSchema,
        CreateThreadProjectNotFoundResponseSchema,
        CreateThreadPersistenceUnavailableResponseSchema,
        CreateThreadModelRouteUnavailableResponseSchema,
        CreateThreadClaudePlanRefusedResponseSchema,
        CreateThreadOrbUnavailableResponseSchema,
        CreateThreadPolicyDeniedResponseSchema,
        CreateThreadProjectlessForbiddenResponseSchema,
        CreateThreadRunnerUnavailableResponseSchema,
        ArchiveThreadInvalidRequestResponseSchema,
        ArchiveThreadNotFoundResponseSchema,
        ArchiveThreadPersistenceUnavailableResponseSchema,
        ArchiveThreadProjectDeletedResponseSchema,
        DeleteProjectInvalidRequestResponseSchema,
        DeleteProjectNameMismatchResponseSchema,
        DeleteProjectNotFoundResponseSchema,
        DeleteProjectPersistenceUnavailableResponseSchema,
        DeleteThreadInvalidRequestResponseSchema,
        DeleteThreadNotFoundResponseSchema,
        DeleteThreadPersistenceUnavailableResponseSchema,
        ThreadDeletedResponseSchema,
        ThreadIdUnavailableResponseSchema,
        SourceControlDeniedResponseSchema,
        SourceControlProviderFailureResponseSchema,
        ThreadSharingErrorResponseSchema,
        SpaceErrorResponseSchema,
      ]),
    )(body).catch(() => undefined);
    if (settingsError !== undefined) {
      throw new ApiError(
        response.status,
        // A provider's own reason (Orb credentials) says what to fix.
        "detail" in settingsError.data &&
          typeof settingsError.data.detail === "string"
          ? settingsError.data.detail
          : settingsError.data.message,
        settingsError.data.code,
        "fieldErrors" in settingsError.data
          ? settingsError.data.fieldErrors
          : undefined,
        "currentRevision" in settingsError.data
          ? settingsError.data.currentRevision
          : undefined,
        true,
        settingsError.data,
      );
    }
    throw new ApiError(response.status, "Request failed.");
  }
  const body: unknown = await response.json().catch(() => undefined);
  return Schema.decodeUnknownPromise(schema)(body);
};

export interface ProjectPage {
  readonly items: ReadonlyArray<ProjectData>;
  readonly nextCursor?: PageCursor;
}

export type ThreadListClientItem = ThreadData &
  Partial<
    Pick<
      ThreadListItem,
      | "mode"
      | "changes"
      | "childCount"
      | "unread"
      | "turnFailed"
      | "childActivity"
    >
  >;

/**
 * `roots`: Threads not listed under a parent, with their child counts. A
 * Thread ID: that parent's child Threads.
 */
export type ThreadListTree = "roots" | ThreadId;

export interface ThreadPage {
  readonly items: ReadonlyArray<ThreadListClientItem>;
  /** Roots lists only: the children listed under this page's roots. */
  readonly children?: ReadonlyArray<ThreadListClientItem>;
  readonly nextCursor?: PageCursor;
}

export type McpServersTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export type SkillsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export type PluginsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const pluginTriggersBase = "/v1/settings/personal/triggers";

export const listPluginTriggers = async (signal?: AbortSignal) =>
  (
    await request(pluginTriggersBase, ListPluginTriggersResponseSchema, {
      signal,
    })
  ).data;

export const createPluginTrigger = async (input: {
  readonly pluginId: PluginId;
  readonly pluginVersion: PluginVersion;
  readonly capabilityName: string;
  readonly hmacSecretReference?: EnvironmentVariableConfigReference;
}) =>
  (
    await request(pluginTriggersBase, CreatePluginTriggerResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;

export const updatePluginTriggerState = async (
  triggerId: PluginTriggerId,
  status: "active" | "paused",
) =>
  (
    await request(
      `${pluginTriggersBase}/${encodeURIComponent(triggerId)}`,
      UpdatePluginTriggerStateResponseSchema,
      { method: "PATCH", body: JSON.stringify({ status }) },
    )
  ).data;

export const rotatePluginTrigger = async (triggerId: PluginTriggerId) =>
  (
    await request(
      `${pluginTriggersBase}/${encodeURIComponent(triggerId)}/rotate`,
      RotatePluginTriggerResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const revokePluginTrigger = async (triggerId: PluginTriggerId) =>
  (
    await request(
      `${pluginTriggersBase}/${encodeURIComponent(triggerId)}`,
      RevokePluginTriggerResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedTriggerId;

export const retryPluginTriggerDelivery = async (
  triggerId: PluginTriggerId,
  deliveryId: PluginTriggerDeliveryId,
) =>
  (
    await request(
      `${pluginTriggersBase}/${encodeURIComponent(triggerId)}/deliveries/${encodeURIComponent(deliveryId)}/retry`,
      RetryPluginTriggerDeliveryResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export interface McpServerInput {
  readonly name: string;
  readonly endpoint: string;
  /** `auto` lets the server decide between no auth, OAuth, and a token. */
  readonly authType?: "auto" | "none" | "bearer" | "oauth";
  readonly authReference?: EnvironmentVariableConfigReference;
  /** Write-only bearer token, stored encrypted on the server. */
  readonly authToken?: string;
  /** The module Code imports the server's tools under. */
  readonly moduleId?: string;
  /** Sent as the MCP client name; empty restores the default. */
  readonly clientName?: string;
  /** An own OAuth app; empty removes it. */
  readonly oauthClientId?: string;
  /** Write-only. */
  readonly oauthClientSecret?: string;
  /** The full header list; a secret without a value keeps its stored value. */
  readonly headers?: ReadonlyArray<{
    readonly name: string;
    readonly value?: string;
    readonly secret?: boolean;
  }>;
  readonly timeoutMs: number;
  /** Omitted: the server is available to all projects (API default). */
  readonly projectIds?: ReadonlyArray<string>;
  /** Omitted: all workspace roles (API default). */
  readonly roles?: ReadonlyArray<string>;
}

export type CreateProjectInput = typeof CreateProjectRequestSchema.Encoded;

export const listThreads = async (
  projectId?: ProjectId,
  cursor?: PageCursor,
  signal?: AbortSignal,
  lifecycleState?: "active" | "archived",
  tree?: ThreadListTree,
): Promise<ThreadPage> => {
  const query = new URLSearchParams({ limit: "100" });
  if (lifecycleState !== undefined) query.set("lifecycleState", lifecycleState);
  if (tree === "roots") query.set("roots", "true");
  else if (tree !== undefined) query.set("parentThreadId", tree);
  if (projectId !== undefined) query.set("projectId", projectId);
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(`/v1/threads?${query}`, ListThreadsResponseSchema, { signal })
  ).data;
};

export interface ThreadSearchPage {
  readonly items: ReadonlyArray<SearchThreadsItem>;
  readonly nextCursor?: string;
}

/** Thread search: the signed-in person's Threads and Threads shared with them. */
export const searchThreads = async (
  query: string,
  cursor?: string,
  signal?: AbortSignal,
): Promise<ThreadSearchPage> =>
  (
    await dxClient.call(
      SearchThreadsEndpoint,
      {
        query: {
          q: query,
          limit: 30,
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    )
  ).data;

export const setThreadPinned = async (
  threadId: ThreadId,
  pinned: boolean,
): Promise<ThreadData> =>
  (
    await dxClient.call(PinThreadEndpoint, {
      params: { threadId },
      body: { pinned },
    })
  ).data;

/** The requester opened the Thread: what it finished is seen. */
export const markThreadSeen = async (threadId: ThreadId): Promise<void> => {
  await dxClient.call(MarkThreadSeenEndpoint, { params: { threadId } });
};

/** Hands a new Thread's first message that failed to start to its agent again. */
export const retryInitialDispatch = async (threadId: ThreadId) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/initial-dispatch/retry`,
      RetryInitialDispatchResponseSchema,
      { method: "POST" },
    )
  ).data;

/** Snoozes the Thread until `snoozedUntil`, or wakes it when null. */
export const setThreadSnoozed = async (
  threadId: ThreadId,
  snoozedUntil: Date | null,
): Promise<ThreadData> =>
  (
    await dxClient.call(SnoozeThreadEndpoint, {
      params: { threadId },
      body: {
        snoozedUntil:
          snoozedUntil === null ? null : DateTime.fromDateUnsafe(snoozedUntil),
      },
    })
  ).data;

export const updateThread = async (
  threadId: ThreadId,
  update: UpdateThreadRequest,
): Promise<ThreadData> =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}`,
      UpdateThreadResponseSchema,
      { method: "PATCH", body: JSON.stringify(update) },
    )
  ).data;

export const listSharedThreads = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThreadListClientItem>> =>
  (
    await request("/v1/shared-threads", ListSharedThreadsResponseSchema, {
      signal,
    })
  ).data.items;

export const updateThreadSharing = async (
  threadId: ThreadId,
  input: UpdateThreadSharingRequest,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/sharing`,
      UpdateThreadSharingResponseSchema,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).data;

export const getThreadMembers = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/members`,
      GetThreadMembersResponseSchema,
      { signal },
    )
  ).data.members;

export const setThreadFollowing = async (
  threadId: ThreadId,
  following: boolean,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/follow`,
      ThreadFollowResponseSchema,
      { method: following ? "PUT" : "DELETE" },
    )
  ).data;

/** An archive or restore, and the child Threads it changed with it. */
export interface ArchivedThread {
  readonly thread: ThreadData;
  readonly changedChildThreadIds?: ReadonlyArray<ThreadId>;
  /** Archived, but its Orb couldn't be stopped yet; the server finishes it. */
  readonly orbStopping?: true;
}

/**
 * `children`: true for every child in the parent's former state, or the
 * exact children to change, as an Undo restores them. `reason: "ship"`
 * archives it from its Ship outcome, so its work counts as shipped.
 */
export const setThreadArchived = async (
  threadId: ThreadId,
  archived: boolean,
  children?: true | ReadonlyArray<ThreadId>,
  reason?: "ship",
): Promise<ArchivedThread> => {
  const response = await request(
    `/v1/threads/${encodeURIComponent(threadId)}/archive`,
    ArchiveThreadResponseSchema,
    {
      method: "PATCH",
      body: JSON.stringify({
        archived,
        ...(children === undefined
          ? {}
          : {
              includeChildren: true,
              ...(children === true ? {} : { childThreadIds: children }),
            }),
        ...(reason === undefined ? {} : { reason }),
      }),
    },
  );
  return {
    thread: response.data,
    ...(response.changedChildThreadIds === undefined
      ? {}
      : { changedChildThreadIds: response.changedChildThreadIds }),
    ...(response.orbStopping === true ? { orbStopping: true as const } : {}),
  };
};

/**
 * Deletes a Thread for good: its conversation, sandbox, and files. `pending`
 * cleanup finishes on the server.
 */
export const deleteThread = async (
  threadId: ThreadId,
  includeChildren = false,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}${
        includeChildren ? "?includeChildren=true" : ""
      }`,
      DeleteThreadResponseSchema,
      { method: "DELETE" },
    )
  ).data;

/** One Thread's sidebar row, exactly as the requester's lists hold it. */
export const getThreadListItem = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadListClientItem> =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/list-item`,
      GetThreadListItemResponseSchema,
      { signal },
    )
  ).data;

export const getThreadReadiness = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/readiness`,
      GetThreadReadinessResponseSchema,
      { signal },
    )
  ).data;

export type ModelRoutingTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const modelRoutingBase = (target: ModelRoutingTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/model-routing"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/model-routing`;

export const getModelCatalog = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/catalog`,
      CatalogResponseSchema,
      { signal },
    )
  ).data;

export const listModelConnections = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
): Promise<ReadonlyArray<ConnectionData>> =>
  (
    await request(
      `${modelRoutingBase(target)}/connections`,
      ListConnectionsResponseSchema,
      { signal },
    )
  ).data.connections;

export const getModelRoutingGraph = async (
  target: ModelRoutingTarget,
  signal?: AbortSignal,
) =>
  (
    await request(`${modelRoutingBase(target)}/graph`, GraphResponseSchema, {
      signal,
    })
  ).data;

export const getModelRoutingChoices = async (signal?: AbortSignal) =>
  (
    await request(
      "/v1/settings/personal/model-routing/choices",
      ChoicesResponseSchema,
      { signal },
    )
  ).data;

export const getModeProfile = async (signal?: AbortSignal) =>
  (
    await request(
      "/v1/settings/personal/model-routing/profile",
      ProfileResponseSchema,
      { signal },
    )
  ).data;

export const putProfileMode = async (
  mode: string,
  config: typeof PutModeRequestSchema.Encoded,
) =>
  (
    await request(
      `/v1/settings/personal/model-routing/profile/modes/${encodeURIComponent(mode)}`,
      ProfileResponseSchema,
      { method: "PUT", body: JSON.stringify(config) },
    )
  ).data;

export const resetProfileMode = async (mode: string) =>
  (
    await request(
      `/v1/settings/personal/model-routing/profile/modes/${encodeURIComponent(mode)}`,
      ProfileResponseSchema,
      { method: "DELETE" },
    )
  ).data;

/** Settings → Models → Space: the model new Spaces run on, and its route. */
export const getSpaceAgentModel = async (signal?: AbortSignal) =>
  (
    await request(
      "/v1/settings/personal/space-agent-model",
      GetSpaceAgentModelResponseSchema,
      { signal },
    )
  ).data;

/** `null` returns new Spaces to Auto (Claude Opus 5.5, medium). */
export const putSpaceAgentModel = async (
  pin: (typeof UpdateSpaceAgentModelRequestSchema.Encoded)["pin"],
) =>
  (
    await request(
      "/v1/settings/personal/space-agent-model",
      GetSpaceAgentModelResponseSchema,
      { method: "PUT", body: JSON.stringify({ pin }) },
    )
  ).data;

export const getWorkspaceModelRoutingChoices = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${modelRoutingBase({ scope: "workspace", workspaceSlug })}/choices`,
      ChoicesResponseSchema,
      { signal },
    )
  ).data;

export const getWorkspaceModeProfile = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${modelRoutingBase({ scope: "workspace", workspaceSlug })}/profile`,
      ProfileResponseSchema,
      { signal },
    )
  ).data;

export const putWorkspaceProfileMode = async (
  workspaceSlug: WorkspaceSlug,
  mode: string,
  config: typeof PutModeRequestSchema.Encoded,
) =>
  (
    await request(
      `${modelRoutingBase({ scope: "workspace", workspaceSlug })}/profile/modes/${encodeURIComponent(mode)}`,
      ProfileResponseSchema,
      { method: "PUT", body: JSON.stringify(config) },
    )
  ).data;

export const resetWorkspaceProfileMode = async (
  workspaceSlug: WorkspaceSlug,
  mode: string,
) =>
  (
    await request(
      `${modelRoutingBase({ scope: "workspace", workspaceSlug })}/profile/modes/${encodeURIComponent(mode)}`,
      ProfileResponseSchema,
      { method: "DELETE" },
    )
  ).data;

const workspaceSettingsBase = (workspaceSlug: WorkspaceSlug) =>
  `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}`;

export const listWorkspaceMembers = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/members`,
      ListWorkspaceMembersResponseSchema,
      { signal },
    )
  ).data;

export const updateWorkspaceMemberRole = async (
  workspaceSlug: WorkspaceSlug,
  userId: string,
  role: "admin" | "member",
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/members/${encodeURIComponent(userId)}`,
      WorkspaceMemberResponseSchema,
      { method: "PATCH", body: JSON.stringify({ role }) },
    )
  ).data;

export const removeWorkspaceMember = async (
  workspaceSlug: WorkspaceSlug,
  userId: string,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/members/${encodeURIComponent(userId)}`,
      RemoveWorkspaceMemberResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const transferWorkspaceOwnership = async (
  workspaceSlug: WorkspaceSlug,
  userId: string,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/members/${encodeURIComponent(userId)}/transfer-ownership`,
      WorkspaceMemberResponseSchema,
      { method: "POST" },
    )
  ).data;

export const deleteWorkspace = async (
  workspaceSlug: WorkspaceSlug,
  input: DeleteWorkspaceRequest,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/delete`,
      DeleteWorkspaceResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export const leaveWorkspace = async (workspaceSlug: WorkspaceSlug) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/leave`,
      LeaveWorkspaceResponseSchema,
      { method: "POST" },
    )
  ).data;

export const listWorkspaceInviteLinks = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/invite-links`,
      ListWorkspaceInviteLinksResponseSchema,
      { signal },
    )
  ).data.links;

export const createWorkspaceInviteLink = async (
  workspaceSlug: WorkspaceSlug,
  input: CreateWorkspaceInviteLinkRequest,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/invite-links`,
      WorkspaceInviteLinkResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export const revokeWorkspaceInviteLink = async (
  workspaceSlug: WorkspaceSlug,
  linkId: string,
) =>
  (
    await request(
      `${workspaceSettingsBase(workspaceSlug)}/invite-links/${encodeURIComponent(linkId)}`,
      RevokeWorkspaceInviteLinkResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const getWorkspaceInvite = async (token: string, signal?: AbortSignal) =>
  (
    await request(
      `/api/invites/${encodeURIComponent(token)}`,
      WorkspaceInvitePreviewResponseSchema,
      { signal },
    )
  ).data;

export const acceptWorkspaceInvite = async (token: string) =>
  (
    await request(
      `/v1/invites/${encodeURIComponent(token)}/accept`,
      AcceptWorkspaceInviteResponseSchema,
      { method: "POST" },
    )
  ).data;

const personalModelSubscriptionsBase =
  "/v1/settings/personal/model-routing/subscriptions";

export const listPersonalModelSubscriptions = async (signal?: AbortSignal) =>
  (
    await request(
      personalModelSubscriptionsBase,
      ListPersonalModelSubscriptionsResponseSchema,
      { signal },
    )
  ).data;

export const beginGitHubCopilotAuthorization = async () =>
  (
    await request(
      `${personalModelSubscriptionsBase}/github-copilot/authorize`,
      BeginPersonalModelSubscriptionAuthorizationResponseSchema,
      { method: "POST" },
    )
  ).data;

export const pollPersonalModelSubscriptionAuthorization = async (
  authorizationId: string,
) =>
  (
    await request(
      `${personalModelSubscriptionsBase}/authorization/${encodeURIComponent(authorizationId)}/poll`,
      PollPersonalModelSubscriptionAuthorizationResponseSchema,
      { method: "POST" },
    )
  ).data;

export const refreshPersonalModelSubscription = async (connectionId: string) =>
  (
    await request(
      `${personalModelSubscriptionsBase}/connections/${encodeURIComponent(connectionId)}/refresh`,
      RefreshPersonalModelSubscriptionResponseSchema,
      { method: "POST" },
    )
  ).data;

export const disconnectPersonalModelSubscription = async (
  connectionId: string,
) =>
  (
    await request(
      `${personalModelSubscriptionsBase}/connections/${encodeURIComponent(connectionId)}`,
      DisconnectPersonalModelSubscriptionResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const createModelConnection = async (
  target: ModelRoutingTarget,
  input: typeof CreateConnectionRequestSchema.Encoded,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections`,
      ConnectionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(input),
      },
    )
  ).data;

export const updateModelConnection = async (
  target: ModelRoutingTarget,
  connectionId: string,
  input: typeof UpdateConnectionRequestSchema.Encoded,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/${encodeURIComponent(connectionId)}`,
      ConnectionResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const setModelConnectionEnabled = async (
  target: ModelRoutingTarget,
  connectionId: string,
  enabled: boolean,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/${encodeURIComponent(connectionId)}/enabled`,
      ConnectionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          enabled,
        } satisfies typeof SetConnectionEnabledRequestSchema.Encoded),
      },
    )
  ).data;

export const setClaudePlanExtraUsage = async (
  target: ModelRoutingTarget,
  connectionId: string,
  allowExtraUsage: boolean,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/${encodeURIComponent(connectionId)}/claude-plan`,
      ConnectionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          allowExtraUsage,
        } satisfies typeof SetClaudePlanRequestSchema.Encoded),
      },
    )
  ).data;

export const checkModelConnectionAccess = async (
  target: ModelRoutingTarget,
  connectionId: string,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/${encodeURIComponent(connectionId)}/check-access`,
      ConnectionResponseSchema,
      { method: "POST" },
    )
  ).data;

export const deleteModelConnection = async (
  target: ModelRoutingTarget,
  connectionId: string,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/${encodeURIComponent(connectionId)}`,
      DeleteConnectionResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const reorderModelConnections = async (
  target: ModelRoutingTarget,
  orderedIds: ReadonlyArray<string>,
) =>
  (
    await request(
      `${modelRoutingBase(target)}/connections/reorder`,
      ReorderConnectionsResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          orderedIds,
        } satisfies typeof ReorderConnectionsRequestSchema.Encoded),
      },
    )
  ).data;

export const getThread = async (
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadDetailData> =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}`,
      GetThreadResponseSchema,
      { signal },
    )
  ).data;

export type ProjectDefaultsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export interface ExternalApiApplicationPage {
  readonly items: ReadonlyArray<ExternalApiApplicationData>;
  readonly nextCursor?: PageCursor;
  readonly permissions: ReadonlyArray<WorkspacePermission>;
}

export interface ExternalApiApplicationAuditPage {
  readonly items: ReadonlyArray<ExternalApiApplicationAuditEventData>;
  readonly nextCursor?: PageCursor;
}

const applicationsBase = (workspaceSlug: WorkspaceSlug) =>
  `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/applications`;

export const listExternalApiApplications = async (
  workspaceSlug: WorkspaceSlug,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ExternalApiApplicationPage> => {
  const query = new URLSearchParams({ limit: "20" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(
      `${applicationsBase(workspaceSlug)}?${query}`,
      ListExternalApiApplicationsResponseSchema,
      { signal },
    )
  ).data;
};

export const createExternalApiApplication = async (
  workspaceSlug: WorkspaceSlug,
  input: CreateExternalApiApplicationRequest,
) =>
  (
    await request(
      applicationsBase(workspaceSlug),
      CreateExternalApiApplicationResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export const updateExternalApiApplication = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
  input: UpdateExternalApiApplicationRequest,
): Promise<ExternalApiApplicationData> =>
  (
    await request(
      `${applicationsBase(workspaceSlug)}/${encodeURIComponent(applicationId)}`,
      UpdateExternalApiApplicationResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const rotateExternalApiApplication = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
  overlapSeconds: ExternalApiApplicationRotationOverlapSeconds,
) =>
  (
    await request(
      `${applicationsBase(workspaceSlug)}/${encodeURIComponent(applicationId)}/rotate`,
      RotateExternalApiApplicationResponseSchema,
      { method: "POST", body: JSON.stringify({ overlapSeconds }) },
    )
  ).data;

export const setExternalApiApplicationEnabled = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
  enabled: boolean,
): Promise<ExternalApiApplicationData> =>
  (
    await request(
      `${applicationsBase(workspaceSlug)}/${encodeURIComponent(applicationId)}/${enabled ? "enable" : "disable"}`,
      SetExternalApiApplicationStatusResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const revokeExternalApiApplication = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
): Promise<ExternalApiApplicationId> =>
  (
    await request(
      `${applicationsBase(workspaceSlug)}/${encodeURIComponent(applicationId)}`,
      RevokeExternalApiApplicationResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedApplicationId;

export const listExternalApiApplicationAudit = async (
  workspaceSlug: WorkspaceSlug,
  applicationId: ExternalApiApplicationId,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ExternalApiApplicationAuditPage> => {
  const query = new URLSearchParams({ limit: "25" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(
      `${applicationsBase(workspaceSlug)}/${encodeURIComponent(applicationId)}/audit?${query}`,
      ListExternalApiApplicationAuditResponseSchema,
      { signal },
    )
  ).data;
};

/** The signed-in person's sidebar layout, shared by their devices. */
export const getSidebarLayout = async (signal?: AbortSignal) =>
  (await dxClient.call(GetSidebarLayoutEndpoint, {}, { signal })).data;

/** Records one sidebar choice and returns the whole layout. */
export const putSidebarLayoutEntry = async (entry: SidebarLayoutChoice) =>
  (await dxClient.call(UpdateSidebarLayoutEndpoint, { body: entry })).data;

/** Records the desktop sidebar's width and returns the whole layout. */
export const putSidebarWidth = async (width: number) =>
  (
    await dxClient.call(UpdateSidebarLayoutEndpoint, {
      body: { kind: "width", width },
    })
  ).data;

/** Records whether the desktop sidebar is collapsed; returns the layout. */
export const putSidebarCollapsed = async (collapsed: boolean) =>
  (
    await dxClient.call(UpdateSidebarLayoutEndpoint, {
      body: { kind: "collapsed", collapsed },
    })
  ).data;

/** The signed-in person's panes and tabs on a Thread; null until saved. */
export const getThreadPaneLayout = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetThreadPaneLayoutEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data.layout;

/** Saves the person's panes and tabs on a Thread. */
export const putThreadPaneLayout = async (
  threadId: ThreadId,
  layout: ThreadPaneLayout,
) =>
  (
    await dxClient.call(UpdateThreadPaneLayoutEndpoint, {
      params: { threadId },
      body: layout,
    })
  ).data.layout;

/**
 * A composer's draft: a Thread's, `/v1/threads/:threadId/draft` with an
 * optional `?slot=`, or a workspace's, `/v1/drafts/workspaces/:workspace/:slot`.
 */
export type ComposerDraftLocation =
  | { readonly threadId: ThreadId; readonly slot?: ThreadDraftSlot }
  | { readonly workspace: string; readonly slot: WorkspaceDraftSlot };

/** The signed-in person's unsent text in one composer; "" if none. */
export const getComposerDraft = async (
  draft: ComposerDraftLocation,
  signal?: AbortSignal,
) =>
  ("threadId" in draft
    ? await dxClient.call(
        GetThreadDraftEndpoint,
        {
          params: { threadId: draft.threadId },
          query: draft.slot === undefined ? {} : { slot: draft.slot },
        },
        { signal },
      )
    : await dxClient.call(
        GetWorkspaceDraftEndpoint,
        { params: { workspace: draft.workspace, slot: draft.slot } },
        { signal },
      )
  ).data.text;

/**
 * Saves the person's draft in one composer; `""` removes it. `keepalive`
 * lets a save started as the page unloads finish.
 */
export const putComposerDraft = async (
  draft: ComposerDraftLocation,
  text: string,
  keepalive: boolean,
) =>
  ("threadId" in draft
    ? await dxClient.call(
        UpdateThreadDraftEndpoint,
        {
          params: { threadId: draft.threadId },
          query: draft.slot === undefined ? {} : { slot: draft.slot },
          body: { text },
        },
        { keepalive },
      )
    : await dxClient.call(
        UpdateWorkspaceDraftEndpoint,
        {
          params: { workspace: draft.workspace, slot: draft.slot },
          body: { text },
        },
        { keepalive },
      )
  ).data.text;
