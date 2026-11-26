import {
  ArchiveThreadEndpoint,
  ArchiveThreadInvalidRequestResponseSchema,
  ArchiveThreadNotFoundResponseSchema,
  ArchiveThreadPersistenceUnavailableResponseSchema,
  ArchiveThreadProjectDeletedResponseSchema,
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  ChoicesResponseSchema,
  type CreateExternalApiApplicationRequest,
  CreateExternalApiApplicationResponseSchema,
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
  DeleteProjectInvalidRequestResponseSchema,
  DeleteProjectNameMismatchResponseSchema,
  DeleteProjectNotFoundResponseSchema,
  DeleteProjectPersistenceUnavailableResponseSchema,
  DeleteThreadEndpoint,
  DeleteThreadInvalidRequestResponseSchema,
  DeleteThreadNotFoundResponseSchema,
  DeleteThreadPersistenceUnavailableResponseSchema,
  DisconnectPersonalModelSubscriptionResponseSchema,
  type ExternalApiApplicationAuditEventData,
  type ExternalApiApplicationData,
  ExternalApiApplicationsErrorResponseSchema,
  FollowThreadEndpoint,
  GetSidebarLayoutEndpoint,
  GetSpaceAgentModelResponseSchema,
  GetThreadDraftEndpoint,
  GetThreadEndpoint,
  GetThreadListItemEndpoint,
  GetThreadMembersEndpoint,
  GetThreadPaneLayoutEndpoint,
  GetThreadReadinessEndpoint,
  GetWorkspaceDraftEndpoint,
  GraphResponseSchema,
  IntegrationsErrorResponseSchema,
  ListExternalApiApplicationAuditResponseSchema,
  ListExternalApiApplicationsResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
  ListSharedThreadsEndpoint,
  ListThreadsEndpoint,
  MarkThreadSeenEndpoint,
  ModelRoutingErrorResponseSchema,
  PersonalAccountPersistenceUnavailableResponseSchema,
  PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  PersonalModelSubscriptionInUseResponseSchema,
  PersonalModelSubscriptionNotFoundResponseSchema,
  PersonalModelSubscriptionUnavailableResponseSchema,
  PinThreadEndpoint,
  PluginBundlesErrorResponseSchema,
  PollPersonalModelSubscriptionAuthorizationResponseSchema,
  ProfileResponseSchema,
  type ProjectData,
  ProjectIconNotImageResponseSchema,
  ProjectIconTooLargeResponseSchema,
  ProjectOrbScriptsForbiddenResponseSchema,
  type PutModeRequestSchema,
  RefreshPersonalModelSubscriptionResponseSchema,
  RetryInitialDispatchEndpoint,
  RevokeExternalApiApplicationResponseSchema,
  RotateExternalApiApplicationResponseSchema,
  SearchThreadsEndpoint,
  type SearchThreadsItem,
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
  ThreadIdUnavailableResponseSchema,
  type ThreadListItem,
  type ThreadPaneLayout,
  ThreadSharingErrorResponseSchema,
  UnfollowThreadEndpoint,
  type UpdateExternalApiApplicationRequest,
  UpdateExternalApiApplicationResponseSchema,
  UpdateProjectNameConflictResponseSchema,
  UpdateSidebarLayoutEndpoint,
  type UpdateSpaceAgentModelRequestSchema,
  UpdateThreadDraftEndpoint,
  UpdateThreadEndpoint,
  UpdateThreadPaneLayoutEndpoint,
  type UpdateThreadRequest,
  UpdateThreadSharingEndpoint,
  type UpdateThreadSharingRequest,
  UpdateWorkspaceDraftEndpoint,
  type WorkspaceDraftSlot,
  WorkspacePolicyErrorResponseSchema,
} from "@dx/api";
import { ApiError, createDxClient, endpointPath } from "@dx/client";
import type {
  EnvironmentVariableConfigReference,
  ExternalApiApplicationId,
  ExternalApiApplicationRotationOverlapSeconds,
  PageCursor,
  ProjectId,
  ThreadId,
  WorkspacePermission,
  WorkspaceSlug,
} from "@dx/domain";
import { DateTime, Schema } from "effect";
import { noticeUnauthenticated } from "../auth/session-ended.js";
import { observeRequest } from "../diagnostics/client-diagnostics.js";
import { takeBootRead } from "../same-origin-fetch.js";

/**
 * `endpointPath` for a WebSocket URL or `src`, and `createDxClient` for a
 * feature with its own fetch. Feature code takes them from here, not from
 * `@dx/client`, so `@dx/client` stays in this module's chunk instead of a
 * chunk of its own on the Thread page's first load.
 */
export { ApiError, createDxClient, endpointPath };

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
  return (
    await dxClient.call(
      ListThreadsEndpoint,
      {
        query: {
          limit: 100,
          ...(lifecycleState === undefined ? {} : { lifecycleState }),
          ...(tree === "roots"
            ? { roots: "true" as const }
            : tree === undefined
              ? {}
              : { parentThreadId: tree }),
          ...(projectId === undefined ? {} : { projectId }),
          ...(cursor === undefined ? {} : { cursor }),
        },
      },
      { signal },
    )
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
  (await dxClient.call(RetryInitialDispatchEndpoint, { params: { threadId } }))
    .data;

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
    await dxClient.call(UpdateThreadEndpoint, {
      params: { threadId },
      body: update,
    })
  ).data;

export const listSharedThreads = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<ThreadListClientItem>> =>
  (await dxClient.call(ListSharedThreadsEndpoint, {}, { signal })).data.items;

export const updateThreadSharing = async (
  threadId: ThreadId,
  input: UpdateThreadSharingRequest,
) =>
  (
    await dxClient.call(UpdateThreadSharingEndpoint, {
      params: { threadId },
      body: input,
    })
  ).data;

export const getThreadMembers = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetThreadMembersEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data.members;

export const setThreadFollowing = async (
  threadId: ThreadId,
  following: boolean,
) =>
  (
    await dxClient.call(
      following ? FollowThreadEndpoint : UnfollowThreadEndpoint,
      { params: { threadId } },
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
  const response = await dxClient.call(ArchiveThreadEndpoint, {
    params: { threadId },
    body: {
      archived,
      ...(children === undefined
        ? {}
        : {
            includeChildren: true,
            ...(children === true ? {} : { childThreadIds: children }),
          }),
      ...(reason === undefined ? {} : { reason }),
    },
  });
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
    await dxClient.call(DeleteThreadEndpoint, {
      params: { threadId },
      query: includeChildren ? { includeChildren: "true" } : {},
    })
  ).data;

/** One Thread's sidebar row, exactly as the requester's lists hold it. */
export const getThreadListItem = async (
  threadId: ThreadId,
  signal?: AbortSignal,
): Promise<ThreadListClientItem> =>
  (
    await dxClient.call(
      GetThreadListItemEndpoint,
      { params: { threadId } },
      { signal },
    )
  ).data;

export const getThreadReadiness = async (
  threadId: ThreadId,
  signal?: AbortSignal,
) =>
  (
    await dxClient.call(
      GetThreadReadinessEndpoint,
      { params: { threadId } },
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

export const getThread = async (
  threadId: string,
  signal?: AbortSignal,
): Promise<ThreadDetailData> =>
  (
    await dxClient.call(
      GetThreadEndpoint,
      // Callers pass a ThreadId; Core answers any other value as invalid.
      { params: { threadId: threadId as ThreadId } },
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
