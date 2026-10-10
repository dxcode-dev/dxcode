import {
  AcceptWorkspaceInviteResponseSchema,
  AddVerificationKeyResponseSchema,
  ApplyBulkEnvironmentVariablesResponseSchema,
  ArchiveThreadExecutionUnavailableResponseSchema,
  ArchiveThreadInvalidRequestResponseSchema,
  ArchiveThreadNotFoundResponseSchema,
  ArchiveThreadPersistenceUnavailableResponseSchema,
  ArchiveThreadResponseSchema,
  BeginGitHubCeremonyResponseSchema,
  BeginGitHubInstallationResponseSchema,
  BeginIntegrationAuthorizationResponseSchema,
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  type BrowserSessionData,
  type BulkEnvironmentVariablePreviewItem,
  CatalogResponseSchema,
  CheckIntegrationHealthResponseSchema,
  ChoicesResponseSchema,
  type ConnectionData,
  ConnectionResponseSchema,
  type CreateConnectionRequestSchema,
  CreateEnvironmentVariableResponseSchema,
  type CreateExternalApiApplicationRequest,
  CreateExternalApiApplicationResponseSchema,
  CreateManagedSigningKeyResponseSchema,
  CreateMcpServerResponseSchema,
  type CreatePersonalApiTokenRequest,
  CreatePersonalApiTokenResponseSchema,
  CreatePluginTriggerResponseSchema,
  CreateProjectForbiddenResponseSchema,
  CreateProjectInvalidRequestResponseSchema,
  CreateProjectNameConflictResponseSchema,
  CreateProjectPersistenceUnavailableResponseSchema,
  CreateProjectPolicyDeniedResponseSchema,
  type CreateProjectRequestSchema,
  CreateProjectResponseSchema,
  CreateProjectRunnerUnavailableResponseSchema,
  CreateThreadInitialAdmissionUnavailableResponseSchema,
  CreateThreadInvalidRequestResponseSchema,
  CreateThreadModelRouteUnavailableResponseSchema,
  CreateThreadOrbUnavailableResponseSchema,
  CreateThreadPersistenceUnavailableResponseSchema,
  CreateThreadPolicyDeniedResponseSchema,
  CreateThreadProjectlessForbiddenResponseSchema,
  CreateThreadProjectNotFoundResponseSchema,
  CreateThreadRunnerUnavailableResponseSchema,
  type CreateWorkspaceInviteLinkRequest,
  CreateWorkspaceResponseSchema,
  DeleteConnectionResponseSchema,
  DeleteEnvironmentVariableResponseSchema,
  DeleteMcpServerResponseSchema,
  DisconnectIntegrationResponseSchema,
  DisconnectPersonalModelSubscriptionResponseSchema,
  DiscoverMcpServerResponseSchema,
  type EnvironmentVariableAuditEventData,
  type EnvironmentVariableData,
  EnvironmentVariablesErrorResponseSchema,
  ExperimentalFeaturesErrorResponseSchema,
  ExportPersonalUsageResponseSchema,
  ExportSkillResponseSchema,
  ExportWorkspaceUsageAuditResponseSchema,
  ExportWorkspaceUsageResponseSchema,
  type ExternalApiApplicationAuditEventData,
  type ExternalApiApplicationData,
  ExternalApiApplicationsErrorResponseSchema,
  FirstPartyPluginErrorResponseSchema,
  FirstPartyPluginListResponseSchema,
  GetIntegrationDisconnectImpactResponseSchema,
  GetPersonalAccountResponseSchema,
  GetPersonalAgentInstructionsResponseSchema,
  GetPersonalComposerDefaultsResponseSchema,
  GetPersonalExperimentalFeaturesResponseSchema,
  GetPersonalSecurityResponseSchema,
  GetPersonalUsageResponseSchema,
  GetProjectDefaultsResponseSchema,
  GetProjectResponseSchema,
  GetSettingsContextErrorResponseSchema,
  GetSettingsContextResponseSchema,
  GetSigningKeysResponseSchema,
  GetThreadMembersResponseSchema,
  GetThreadReadinessResponseSchema,
  GetThreadResponseSchema,
  GetWorkspacePolicyResponseSchema,
  GetWorkspaceProfileResponseSchema,
  GetWorkspaceUsageResponseSchema,
  GitHubDisconnectResponseSchema,
  type GitHubGrantData,
  GraphResponseSchema,
  ImportSkillResponseSchema,
  InspectWorkspacePrivateThreadResponseSchema,
  IntegrationsErrorResponseSchema,
  LeaveWorkspaceResponseSchema,
  ListBrowserSessionsResponseSchema,
  ListConnectionsResponseSchema,
  ListEnvironmentVariableHistoryResponseSchema,
  ListEnvironmentVariablesResponseSchema,
  ListExternalApiApplicationAuditResponseSchema,
  ListExternalApiApplicationsResponseSchema,
  ListGitHubGrantsResponseSchema,
  ListMcpServersResponseSchema,
  ListPersonalApiTokensResponseSchema,
  ListPersonalIntegrationsResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
  ListPluginsResponseSchema,
  ListPluginTriggersResponseSchema,
  ListProjectsResponseSchema,
  ListSharedThreadsResponseSchema,
  ListSkillsResponseSchema,
  ListThreadsResponseSchema,
  ListWorkspaceInviteLinksResponseSchema,
  ListWorkspaceMembersResponseSchema,
  ListWorkspaceUsageAuditResponseSchema,
  type McpServerData,
  McpServersErrorResponseSchema,
  ModelRoutingErrorResponseSchema,
  OrbProviderErrorResponseSchema,
  type OrbProviderId,
  OrbProviderListResponseSchema,
  type PersonalAccountData,
  PersonalAccountErrorResponseSchema,
  type PersonalAgentInstructionsData,
  PersonalAgentInstructionsErrorResponseSchema,
  type PersonalApiTokenData,
  type PersonalApiTokenSecretData,
  type PersonalComposerDefaultsData,
  type PersonalExperimentalFeaturesData,
  PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
  PersonalModelSubscriptionInUseResponseSchema,
  PersonalModelSubscriptionNotFoundResponseSchema,
  PersonalModelSubscriptionUnavailableResponseSchema,
  type PersonalSecurityData,
  PersonalSecurityErrorResponseSchema,
  type PersonalUsageData,
  PersonalUsageErrorResponseSchema,
  type PersonalUsageExportData,
  PinThreadResponseSchema,
  PluginsErrorResponseSchema,
  PluginTriggersErrorResponseSchema,
  PollPersonalModelSubscriptionAuthorizationResponseSchema,
  PreviewBulkEnvironmentVariablesResponseSchema,
  PreviewPluginResponseSchema,
  PreviewSkillResponseSchema,
  ProfileResponseSchema,
  type ProjectData,
  type ProjectDefaultsData,
  ProjectDefaultsErrorResponseSchema,
  PublishPluginVersionResponseSchema,
  PublishSkillVersionResponseSchema,
  type PutModeRequestSchema,
  RebindProjectSourceResponseSchema,
  RefreshIntegrationResponseSchema,
  RefreshPersonalModelSubscriptionResponseSchema,
  RemovePluginResponseSchema,
  RemoveSkillResponseSchema,
  RemoveWorkspaceMemberResponseSchema,
  type ReorderConnectionsRequestSchema,
  ReorderConnectionsResponseSchema,
  RetryPluginTriggerDeliveryResponseSchema,
  ReviewMcpToolResponseSchema,
  RevokeBrowserSessionResponseSchema,
  RevokeExternalApiApplicationResponseSchema,
  RevokeManagedSigningKeyResponseSchema,
  RevokeOtherBrowserSessionsResponseSchema,
  RevokePersonalApiTokenResponseSchema,
  RevokePluginTriggerResponseSchema,
  RevokeVerificationKeyResponseSchema,
  RevokeWorkspaceInviteLinkResponseSchema,
  RotateEnvironmentVariableResponseSchema,
  RotateExternalApiApplicationResponseSchema,
  RotateManagedSigningKeyResponseSchema,
  RotatePersonalApiTokenResponseSchema,
  RotatePluginTriggerResponseSchema,
  SelectIntegrationRepositoriesResponseSchema,
  type SetConnectionEnabledRequestSchema,
  SetExternalApiApplicationStatusResponseSchema,
  type SetFirstPartyPluginConfigurationRequest,
  type SettingsContextData,
  type SettingsFieldError,
  type SigningKeySetupGuidance,
  type SigningKeysData,
  SigningKeysErrorResponseSchema,
  type SkillData,
  SkillsErrorResponseSchema,
  SourceControlDeniedResponseSchema,
  SourceControlProviderFailureResponseSchema,
  type ThreadData,
  type ThreadDetailData,
  ThreadFollowResponseSchema,
  type ThreadListItem,
  ThreadSharingErrorResponseSchema,
  TrustPluginResponseSchema,
  type UpdateConnectionRequestSchema,
  UpdateEnvironmentVariableResponseSchema,
  type UpdateExternalApiApplicationRequest,
  UpdateExternalApiApplicationResponseSchema,
  UpdateMcpServerResponseSchema,
  UpdateMcpWorkspacePolicyResponseSchema,
  UpdatePersonalAccountResponseSchema,
  UpdatePersonalAgentInstructionsResponseSchema,
  type UpdatePersonalAppearanceRequest,
  UpdatePersonalAppearanceResponseSchema,
  type UpdatePersonalComposerDefaultsRequest,
  UpdatePersonalComposerDefaultsResponseSchema,
  UpdatePersonalExperimentalFeatureResponseSchema,
  UpdatePluginStateResponseSchema,
  UpdatePluginTriggerStateResponseSchema,
  UpdatePluginWorkspacePolicyResponseSchema,
  UpdateProjectDefaultsResponseSchema,
  UpdateProjectNameConflictResponseSchema,
  UpdateProjectResponseSchema,
  UpdateSkillStateResponseSchema,
  UpdateSkillWorkspacePolicyResponseSchema,
  type UpdateThreadSharingRequest,
  UpdateThreadSharingResponseSchema,
  UpdateWorkspacePolicyResponseSchema,
  UpdateWorkspaceProfileResponseSchema,
  WorkspaceInviteLinkResponseSchema,
  WorkspaceInvitePreviewResponseSchema,
  WorkspaceMemberResponseSchema,
  WorkspaceMembersErrorResponseSchema,
  type WorkspacePolicyData,
  WorkspacePolicyErrorResponseSchema,
  type WorkspacePrivateThreadInspectionData,
  type WorkspaceProfileData,
  WorkspaceProfileErrorResponseSchema,
  type WorkspaceUsageAuditExportData,
  type WorkspaceUsageAuditPageData,
  type WorkspaceUsageData,
  WorkspaceUsageErrorResponseSchema,
} from "@dx/api";
import type {
  BrowserSessionId,
  EnvironmentVariableConfigReference,
  ExperimentalFeatureId,
  ExperimentalFeaturePreferencesRevision,
  ExternalApiApplicationId,
  ExternalApiApplicationRotationOverlapSeconds,
  GitIntegrationProvider,
  IntegrationConnectionId,
  IntegrationDisconnectImpact,
  McpServerId,
  McpToolName,
  McpToolSchemaHash,
  PageCursor,
  PersonalApiTokenId,
  PluginGrantedPermissions,
  PluginId,
  PluginImportBundle,
  PluginIntegrity,
  PluginTriggerDeliveryId,
  PluginTriggerId,
  PluginVersion,
  ProjectDefaultOverrides,
  ProjectId,
  ProviderRepositoryId,
  RunnerProfileId,
  SkillId,
  SkillImportBundle,
  SkillIntegrity,
  SkillVersion,
  ThreadId,
  WorkspacePermission,
  WorkspacePolicyRestrictions,
  WorkspaceProjectPolicy,
  WorkspaceSlug,
} from "@dx/domain";
import { Schema } from "effect";

export class ApiError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly currentRevision?: number;
  readonly fieldErrors?: ReadonlyArray<SettingsFieldError>;
  readonly hasValidatedPayload: boolean;

  constructor(
    status: number,
    message: string,
    code?: string,
    fieldErrors?: ReadonlyArray<SettingsFieldError>,
    currentRevision?: number,
    hasValidatedPayload = false,
  ) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.code = code;
    this.fieldErrors = fieldErrors;
    this.currentRevision = currentRevision;
    this.hasValidatedPayload = hasValidatedPayload;
  }
}

export const request = async <
  SchemaType extends Schema.ConstraintDecoder<unknown>,
>(
  path: string,
  schema: SchemaType,
  init?: RequestInit,
): Promise<SchemaType["Type"]> => {
  const response = await fetch(path, {
    ...init,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(init?.body === undefined
        ? {}
        : { "content-type": "application/json" }),
      ...init?.headers,
    },
  });
  if (!response.ok) {
    const body: unknown = await response.json().catch(() => undefined);
    const settingsError = await Schema.decodeUnknownPromise(
      Schema.Union([
        GetSettingsContextErrorResponseSchema,
        PersonalAccountErrorResponseSchema,
        PersonalAgentInstructionsErrorResponseSchema,
        PersonalSecurityErrorResponseSchema,
        WorkspaceProfileErrorResponseSchema,
        WorkspaceMembersErrorResponseSchema,
        WorkspacePolicyErrorResponseSchema,
        EnvironmentVariablesErrorResponseSchema,
        ExternalApiApplicationsErrorResponseSchema,
        ModelRoutingErrorResponseSchema,
        PersonalModelSubscriptionNotFoundResponseSchema,
        PersonalModelSubscriptionBrowserSessionRequiredResponseSchema,
        PersonalModelSubscriptionInUseResponseSchema,
        PersonalModelSubscriptionUnavailableResponseSchema,
        PersonalUsageErrorResponseSchema,
        WorkspaceUsageErrorResponseSchema,
        McpServersErrorResponseSchema,
        SkillsErrorResponseSchema,
        PluginsErrorResponseSchema,
        FirstPartyPluginErrorResponseSchema,
        OrbProviderErrorResponseSchema,
        ExperimentalFeaturesErrorResponseSchema,
        ProjectDefaultsErrorResponseSchema,
        SigningKeysErrorResponseSchema,
        IntegrationsErrorResponseSchema,
        PluginTriggersErrorResponseSchema,
        CreateProjectInvalidRequestResponseSchema,
        CreateProjectNameConflictResponseSchema,
        CreateProjectPersistenceUnavailableResponseSchema,
        CreateProjectForbiddenResponseSchema,
        CreateProjectPolicyDeniedResponseSchema,
        CreateProjectRunnerUnavailableResponseSchema,
        UpdateProjectNameConflictResponseSchema,
        CreateThreadInitialAdmissionUnavailableResponseSchema,
        CreateThreadInvalidRequestResponseSchema,
        CreateThreadProjectNotFoundResponseSchema,
        CreateThreadPersistenceUnavailableResponseSchema,
        CreateThreadModelRouteUnavailableResponseSchema,
        CreateThreadOrbUnavailableResponseSchema,
        CreateThreadPolicyDeniedResponseSchema,
        CreateThreadProjectlessForbiddenResponseSchema,
        CreateThreadRunnerUnavailableResponseSchema,
        ArchiveThreadInvalidRequestResponseSchema,
        ArchiveThreadNotFoundResponseSchema,
        ArchiveThreadPersistenceUnavailableResponseSchema,
        ArchiveThreadExecutionUnavailableResponseSchema,
        SourceControlDeniedResponseSchema,
        SourceControlProviderFailureResponseSchema,
        ThreadSharingErrorResponseSchema,
      ]),
    )(body).catch(() => undefined);
    if (settingsError !== undefined) {
      throw new ApiError(
        response.status,
        settingsError.data.message,
        settingsError.data.code,
        "fieldErrors" in settingsError.data
          ? settingsError.data.fieldErrors
          : undefined,
        "currentRevision" in settingsError.data
          ? settingsError.data.currentRevision
          : undefined,
        true,
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
  Partial<Pick<ThreadListItem, "mode" | "changes">>;

export interface ThreadPage {
  readonly items: ReadonlyArray<ThreadListClientItem>;
  readonly nextCursor?: PageCursor;
}

export const listProjects = async (
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<ProjectPage> => {
  const query = new URLSearchParams({ limit: "100" });
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(`/v1/projects?${query}`, ListProjectsResponseSchema, {
      signal,
    })
  ).data;
};

export type EnvironmentVariablesTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "project"; readonly projectId: ProjectId }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const environmentVariablesBase = (target: EnvironmentVariablesTarget) =>
  target.scope === "workspace"
    ? `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/environment-variables`
    : "/v1/settings/personal/environment-variables";

const environmentVariablesQuery = (target: EnvironmentVariablesTarget) => {
  if (target.scope === "workspace") return "";
  const query = new URLSearchParams({ scope: target.scope });
  if (target.scope === "project") query.set("projectId", target.projectId);
  return `?${query}`;
};

const environmentVariablesScope = (target: EnvironmentVariablesTarget) =>
  target.scope === "project"
    ? { scope: target.scope, projectId: target.projectId }
    : { scope: target.scope };

export const listEnvironmentVariables = async (
  target: EnvironmentVariablesTarget,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${environmentVariablesBase(target)}${environmentVariablesQuery(target)}`,
      ListEnvironmentVariablesResponseSchema,
      { signal },
    )
  ).data;

export const createEnvironmentVariable = async (
  target: EnvironmentVariablesTarget,
  input: {
    readonly name: string;
    readonly kind: "secret" | "variable";
    readonly value: string;
  },
): Promise<EnvironmentVariableData> =>
  (
    await request(
      environmentVariablesBase(target),
      CreateEnvironmentVariableResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          ...environmentVariablesScope(target),
          ...input,
        }),
      },
    )
  ).data;

export const updateEnvironmentVariable = async (
  target: EnvironmentVariablesTarget,
  item: EnvironmentVariableData,
  input: { readonly enabled?: boolean },
): Promise<EnvironmentVariableData> =>
  (
    await request(
      `${environmentVariablesBase(target)}/${encodeURIComponent(item.reference.id)}${environmentVariablesQuery(target)}`,
      UpdateEnvironmentVariableResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const rotateEnvironmentVariable = async (
  target: EnvironmentVariablesTarget,
  item: EnvironmentVariableData,
  value: string,
): Promise<EnvironmentVariableData> =>
  (
    await request(
      `${environmentVariablesBase(target)}/${encodeURIComponent(item.reference.id)}/rotate${environmentVariablesQuery(target)}`,
      RotateEnvironmentVariableResponseSchema,
      { method: "POST", body: JSON.stringify({ value }) },
    )
  ).data;

export const deleteEnvironmentVariable = async (
  target: EnvironmentVariablesTarget,
  item: EnvironmentVariableData,
) =>
  (
    await request(
      `${environmentVariablesBase(target)}/${encodeURIComponent(item.reference.id)}${environmentVariablesQuery(target)}`,
      DeleteEnvironmentVariableResponseSchema,
      { method: "DELETE" },
    )
  ).data.deletedEnvironmentVariableId;

export const listEnvironmentVariableHistory = async (
  target: EnvironmentVariablesTarget,
  cursor?: PageCursor,
  signal?: AbortSignal,
): Promise<{
  readonly items: ReadonlyArray<EnvironmentVariableAuditEventData>;
  readonly nextCursor?: PageCursor;
}> => {
  const query = new URLSearchParams({ scope: target.scope, limit: "20" });
  if (target.scope === "project") query.set("projectId", target.projectId);
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(
      `${environmentVariablesBase(target)}/history?${query}`,
      ListEnvironmentVariableHistoryResponseSchema,
      { signal },
    )
  ).data;
};

export type McpServersTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const mcpServersBase = (target: McpServersTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/mcp-servers"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/mcp-servers`;

export const listMcpServers = async (
  target: McpServersTarget,
  signal?: AbortSignal,
) =>
  (
    await request(mcpServersBase(target), ListMcpServersResponseSchema, {
      signal,
    })
  ).data;

export type SkillsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const skillsBase = (target: SkillsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/skills"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/skills`;

export const listSkills = async (target: SkillsTarget, signal?: AbortSignal) =>
  (await request(skillsBase(target), ListSkillsResponseSchema, { signal }))
    .data;

export const previewSkill = async (
  target: SkillsTarget,
  bundle: SkillImportBundle,
) =>
  (
    await request(`${skillsBase(target)}/preview`, PreviewSkillResponseSchema, {
      method: "POST",
      body: JSON.stringify(bundle),
    })
  ).data;

export const importSkill = async (
  target: SkillsTarget,
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
): Promise<SkillData> =>
  (
    await request(skillsBase(target), ImportSkillResponseSchema, {
      method: "POST",
      body: JSON.stringify({ bundle, reviewedIntegrity }),
    })
  ).data;

export const publishSkillVersion = async (
  target: SkillsTarget,
  skillId: SkillId,
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
  activate: boolean,
): Promise<SkillData> =>
  (
    await request(
      `${skillsBase(target)}/${encodeURIComponent(skillId)}/versions`,
      PublishSkillVersionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ bundle, reviewedIntegrity, activate }),
      },
    )
  ).data;

export const updateSkillState = async (
  target: SkillsTarget,
  skillId: SkillId,
  input: {
    readonly enabled?: boolean;
    readonly activeVersion?: SkillVersion;
    readonly pinned?: boolean;
  },
): Promise<SkillData> =>
  (
    await request(
      `${skillsBase(target)}/${encodeURIComponent(skillId)}`,
      UpdateSkillStateResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    )
  ).data;

export const removeSkill = async (target: SkillsTarget, skillId: SkillId) =>
  (
    await request(
      `${skillsBase(target)}/${encodeURIComponent(skillId)}`,
      RemoveSkillResponseSchema,
      {
        method: "DELETE",
      },
    )
  ).data.removedSkillId;

export const exportSkill = async (
  target: SkillsTarget,
  skillId: SkillId,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${skillsBase(target)}/${encodeURIComponent(skillId)}/export`,
      ExportSkillResponseSchema,
      { signal },
    )
  ).data;

export const updateSkillWorkspacePolicy = async (
  target: Extract<SkillsTarget, { readonly scope: "workspace" }>,
  allowPersonalSkills: boolean,
) =>
  (
    await request(
      `${skillsBase(target)}/policy`,
      UpdateSkillWorkspacePolicyResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify({ allowPersonalSkills }),
      },
    )
  ).data;

export type PluginsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const pluginsBase = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/plugins"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/plugins`;

/** First-party plugins (Search, …): enablement, provider, and credential per scope. */
const firstPartyPluginsBase = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/first-party-plugins"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/first-party-plugins`;

export const listFirstPartyPlugins = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (
    await request(
      firstPartyPluginsBase(target),
      FirstPartyPluginListResponseSchema,
      { signal },
    )
  ).data;

export const setFirstPartyPluginEnablement = async (
  target: PluginsTarget,
  pluginId: string,
  enablement: "enabled" | "disabled" | null,
) =>
  (
    await request(
      `${firstPartyPluginsBase(target)}/${encodeURIComponent(pluginId)}/enablement`,
      FirstPartyPluginListResponseSchema,
      { method: "PUT", body: JSON.stringify({ enablement }) },
    )
  ).data;

export const setFirstPartyPluginConfiguration = async (
  target: PluginsTarget,
  pluginId: string,
  input: SetFirstPartyPluginConfigurationRequest,
) =>
  (
    await request(
      `${firstPartyPluginsBase(target)}/${encodeURIComponent(pluginId)}/configuration`,
      FirstPartyPluginListResponseSchema,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).data;

export const deleteFirstPartyPluginConfiguration = async (
  target: PluginsTarget,
  pluginId: string,
) =>
  (
    await request(
      `${firstPartyPluginsBase(target)}/${encodeURIComponent(pluginId)}/configuration`,
      FirstPartyPluginListResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const setFirstPartyPluginWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  allowPersonalOverrides: boolean,
) =>
  (
    await request(
      `${firstPartyPluginsBase({ scope: "workspace", workspaceSlug })}/policy`,
      FirstPartyPluginListResponseSchema,
      { method: "PUT", body: JSON.stringify({ allowPersonalOverrides }) },
    )
  ).data;

/** Orb providers: bring-your-own keys for key-based providers per scope. */
const orbProvidersBase = (target: PluginsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/orb-providers"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/orb-providers`;

export const listOrbProviders = async (
  target: PluginsTarget,
  projectId?: ProjectId,
  signal?: AbortSignal,
) =>
  (
    await request(
      projectId === undefined
        ? orbProvidersBase(target)
        : `${orbProvidersBase(target)}?projectId=${encodeURIComponent(projectId)}`,
      OrbProviderListResponseSchema,
      { signal },
    )
  ).data;

export const setOrbProviderKey = async (
  target: PluginsTarget,
  providerId: OrbProviderId,
  credential: string,
) =>
  (
    await request(
      `${orbProvidersBase(target)}/${encodeURIComponent(providerId)}/key`,
      OrbProviderListResponseSchema,
      { method: "PUT", body: JSON.stringify({ credential }) },
    )
  ).data;

export const deleteOrbProviderKey = async (
  target: PluginsTarget,
  providerId: OrbProviderId,
) =>
  (
    await request(
      `${orbProvidersBase(target)}/${encodeURIComponent(providerId)}/key`,
      OrbProviderListResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const setOrbProviderWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  allowPersonalKeysOnWorkspaceProjects: boolean,
) =>
  (
    await request(
      `${orbProvidersBase({ scope: "workspace", workspaceSlug })}/policy`,
      OrbProviderListResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({ allowPersonalKeysOnWorkspaceProjects }),
      },
    )
  ).data;

export const listPlugins = async (
  target: PluginsTarget,
  signal?: AbortSignal,
) =>
  (await request(pluginsBase(target), ListPluginsResponseSchema, { signal }))
    .data;

export const previewPlugin = async (
  target: PluginsTarget,
  bundle: PluginImportBundle,
) =>
  (
    await request(
      `${pluginsBase(target)}/preview`,
      PreviewPluginResponseSchema,
      {
        method: "POST",
        body: JSON.stringify(bundle),
      },
    )
  ).data;

export const trustPlugin = async (
  target: PluginsTarget,
  bundle: PluginImportBundle,
  reviewedIntegrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
) =>
  (
    await request(pluginsBase(target), TrustPluginResponseSchema, {
      method: "POST",
      body: JSON.stringify({ bundle, reviewedIntegrity, grants }),
    })
  ).data;

export const publishPluginVersion = async (
  target: PluginsTarget,
  pluginId: PluginId,
  bundle: PluginImportBundle,
  reviewedIntegrity: PluginIntegrity,
  grants: PluginGrantedPermissions,
) =>
  (
    await request(
      `${pluginsBase(target)}/${encodeURIComponent(pluginId)}/versions`,
      PublishPluginVersionResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          bundle,
          reviewedIntegrity,
          grants,
          activate: true,
        }),
      },
    )
  ).data;

export const updatePluginState = async (
  target: PluginsTarget,
  pluginId: PluginId,
  input: { readonly enabled?: boolean; readonly activeVersion?: PluginVersion },
) =>
  (
    await request(
      `${pluginsBase(target)}/${encodeURIComponent(pluginId)}`,
      UpdatePluginStateResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify(input),
      },
    )
  ).data;

export const removePlugin = async (target: PluginsTarget, pluginId: PluginId) =>
  (
    await request(
      `${pluginsBase(target)}/${encodeURIComponent(pluginId)}`,
      RemovePluginResponseSchema,
      { method: "DELETE" },
    )
  ).data.removedPluginId;

export const updatePluginWorkspacePolicy = async (
  target: Extract<PluginsTarget, { readonly scope: "workspace" }>,
  allowPersonalPlugins: boolean,
) =>
  (
    await request(
      `${pluginsBase(target)}/policy`,
      UpdatePluginWorkspacePolicyResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify({ allowPersonalPlugins }),
      },
    )
  ).data.allowPersonalPlugins;

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
  readonly authReference?: EnvironmentVariableConfigReference;
  /** Write-only bearer token, stored encrypted on the server. */
  readonly authToken?: string;
  readonly timeoutMs: number;
  /** Omitted: the server is available to all projects (API default). */
  readonly projectIds?: ReadonlyArray<string>;
  /** Omitted: all workspace roles (API default). */
  readonly roles?: ReadonlyArray<string>;
}

export const createMcpServer = async (
  target: McpServersTarget,
  input: McpServerInput,
): Promise<McpServerData> =>
  (
    await request(mcpServersBase(target), CreateMcpServerResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;

export const updateMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
  input: Omit<Partial<McpServerInput>, "authReference"> & {
    readonly authReference?: EnvironmentVariableConfigReference | null;
    readonly enabled?: boolean;
  },
): Promise<McpServerData> =>
  (
    await request(
      `${mcpServersBase(target)}/${encodeURIComponent(serverId)}`,
      UpdateMcpServerResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const discoverMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<McpServerData> =>
  (
    await request(
      `${mcpServersBase(target)}/${encodeURIComponent(serverId)}/discover`,
      DiscoverMcpServerResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const reviewMcpTool = async (
  target: McpServersTarget,
  serverId: McpServerId,
  toolName: McpToolName,
  schemaHash: McpToolSchemaHash,
  approved: boolean,
): Promise<McpServerData> =>
  (
    await request(
      `${mcpServersBase(target)}/${encodeURIComponent(serverId)}/tools/${encodeURIComponent(toolName)}/review`,
      ReviewMcpToolResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({ schemaHash, approved }),
      },
    )
  ).data;

export const deleteMcpServer = async (
  target: McpServersTarget,
  serverId: McpServerId,
): Promise<McpServerId> =>
  (
    await request(
      `${mcpServersBase(target)}/${encodeURIComponent(serverId)}`,
      DeleteMcpServerResponseSchema,
      { method: "DELETE" },
    )
  ).data.deletedMcpServerId;

export const updateMcpWorkspacePolicy = async (
  target: Extract<McpServersTarget, { readonly scope: "workspace" }>,
  allowPersonalServers: boolean,
): Promise<boolean> =>
  (
    await request(
      `${mcpServersBase(target)}/policy`,
      UpdateMcpWorkspacePolicyResponseSchema,
      {
        method: "PATCH",
        body: JSON.stringify({ allowPersonalServers }),
      },
    )
  ).data.allowPersonalServers;

export const previewBulkEnvironmentVariables = async (
  target: EnvironmentVariablesTarget,
  input: {
    readonly kind: "secret" | "variable";
    readonly contents: string;
  },
): Promise<{
  readonly items: ReadonlyArray<BulkEnvironmentVariablePreviewItem>;
  readonly canApply: boolean;
}> =>
  (
    await request(
      `${environmentVariablesBase(target)}/bulk/preview`,
      PreviewBulkEnvironmentVariablesResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          ...environmentVariablesScope(target),
          ...input,
        }),
      },
    )
  ).data;

export const applyBulkEnvironmentVariables = async (
  target: EnvironmentVariablesTarget,
  input: {
    readonly kind: "secret" | "variable";
    readonly contents: string;
    readonly conflictBehavior: "reject" | "replace";
  },
) =>
  (
    await request(
      `${environmentVariablesBase(target)}/bulk`,
      ApplyBulkEnvironmentVariablesResponseSchema,
      {
        method: "POST",
        body: JSON.stringify({
          ...environmentVariablesScope(target),
          ...input,
        }),
      },
    )
  ).data;

export const listPersonalIntegrations = async (signal?: AbortSignal) =>
  (
    await request(
      "/v1/settings/personal/integrations",
      ListPersonalIntegrationsResponseSchema,
      { signal },
    )
  ).data;

export const beginIntegrationAuthorization = async (
  provider: GitIntegrationProvider,
): Promise<string> =>
  (
    await request(
      `/v1/settings/personal/integrations/${encodeURIComponent(provider)}/authorize`,
      BeginIntegrationAuthorizationResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data.authorizationUrl;

export const selectIntegrationRepositories = async (
  connectionId: IntegrationConnectionId,
  repositoryIds: ReadonlyArray<ProviderRepositoryId>,
) =>
  (
    await request(
      `/v1/settings/personal/integrations/connections/${encodeURIComponent(connectionId)}/repositories`,
      SelectIntegrationRepositoriesResponseSchema,
      { method: "PUT", body: JSON.stringify({ repositoryIds }) },
    )
  ).data.repositories;

export const getIntegrationDisconnectImpact = async (
  connectionId: IntegrationConnectionId,
  signal?: AbortSignal,
): Promise<IntegrationDisconnectImpact> =>
  (
    await request(
      `/v1/settings/personal/integrations/connections/${encodeURIComponent(connectionId)}/disconnect-impact`,
      GetIntegrationDisconnectImpactResponseSchema,
      { signal },
    )
  ).data;

export const disconnectIntegration = async (
  connectionId: IntegrationConnectionId,
) =>
  (
    await request(
      `/v1/settings/personal/integrations/connections/${encodeURIComponent(connectionId)}`,
      DisconnectIntegrationResponseSchema,
      { method: "DELETE" },
    )
  ).data;

export const refreshIntegration = async (
  connectionId: IntegrationConnectionId,
) =>
  (
    await request(
      `/v1/settings/personal/integrations/connections/${encodeURIComponent(connectionId)}/refresh`,
      RefreshIntegrationResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const checkIntegrationHealth = async (
  connectionId: IntegrationConnectionId,
) =>
  (
    await request(
      `/v1/settings/personal/integrations/connections/${encodeURIComponent(connectionId)}/health`,
      CheckIntegrationHealthResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const getProject = async (
  projectId: ProjectId,
  signal?: AbortSignal,
): Promise<ProjectData> =>
  (
    await request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      GetProjectResponseSchema,
      { signal },
    )
  ).data;

export type CreateProjectInput = typeof CreateProjectRequestSchema.Encoded;

export const listGitHubSourceGrants = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<GitHubGrantData>> => {
  const base = "/v1/integrations/github/personal";
  return (
    await request(`${base}/grants`, ListGitHubGrantsResponseSchema, { signal })
  ).data.grants;
};

export const getGitHubIntegrationStatus = async (signal?: AbortSignal) =>
  (
    await request(
      "/v1/integrations/github/personal/grants",
      ListGitHubGrantsResponseSchema,
      { signal },
    )
  ).data;

const githubReturnToQuery = (returnTo?: string) => {
  if (returnTo === undefined) return "";
  return `?${new URLSearchParams({ return_to: returnTo })}`;
};

export const beginGitHubAuthorization = async (
  returnTo?: string,
): Promise<string> =>
  (
    await request(
      `/v1/integrations/github/personal/authorize${githubReturnToQuery(returnTo)}`,
      BeginGitHubCeremonyResponseSchema,
      { method: "POST" },
    )
  ).data.authorizationUrl;

export const beginGitHubInstallation = async (
  returnTo?: string,
): Promise<string> => {
  const base = "/v1/integrations/github/personal";
  return (
    await request(
      `${base}/install${githubReturnToQuery(returnTo)}`,
      BeginGitHubInstallationResponseSchema,
      { method: "POST" },
    )
  ).data.installationUrl;
};

export const disconnectGitHub = async (grantId: string): Promise<void> => {
  await request(
    `/v1/integrations/github/personal/grants/${encodeURIComponent(grantId)}`,
    GitHubDisconnectResponseSchema,
    { method: "DELETE" },
  );
};

export const createProject = async (
  input: CreateProjectInput,
): Promise<ProjectData> =>
  (
    await request("/v1/projects", CreateProjectResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;

export const updateProject = async (
  projectId: ProjectId,
  input: {
    readonly revision: number;
    readonly name?: string;
    readonly description?: string;
    readonly runnerProfileId?: RunnerProfileId;
    readonly additionalRepositories?: ReadonlyArray<string>;
  },
): Promise<ProjectData> =>
  (
    await request(
      `/v1/projects/${encodeURIComponent(projectId)}`,
      UpdateProjectResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const rebindProjectSource = async (
  projectId: ProjectId,
  input: {
    readonly revision: number;
    readonly grantId: string;
    readonly providerRepositoryId: ProviderRepositoryId;
    readonly provider?: "github" | "bitbucket";
    readonly workspaceId?: string;
  },
): Promise<ProjectData> =>
  (
    await request(
      `/v1/projects/${encodeURIComponent(projectId)}/source`,
      RebindProjectSourceResponseSchema,
      { method: "PUT", body: JSON.stringify(input) },
    )
  ).data;

export const uploadProjectIcon = async (
  projectId: ProjectId,
  revision: number,
  file: File,
): Promise<ProjectData> =>
  (
    await request(
      `/v1/projects/${encodeURIComponent(projectId)}/icon`,
      UpdateProjectResponseSchema,
      {
        method: "PUT",
        body: file,
        headers: {
          "content-type": file.type,
          "x-project-revision": String(revision),
        },
      },
    )
  ).data;

export const listThreads = async (
  projectId?: ProjectId,
  cursor?: PageCursor,
  signal?: AbortSignal,
  lifecycleState?: "active" | "archived",
): Promise<ThreadPage> => {
  const query = new URLSearchParams({ limit: "100" });
  if (lifecycleState !== undefined) query.set("lifecycleState", lifecycleState);
  if (projectId !== undefined) query.set("projectId", projectId);
  if (cursor !== undefined) query.set("cursor", cursor);
  return (
    await request(`/v1/threads?${query}`, ListThreadsResponseSchema, { signal })
  ).data;
};

export const setThreadPinned = async (
  threadId: ThreadId,
  pinned: boolean,
): Promise<ThreadData> =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/pin`,
      PinThreadResponseSchema,
      { method: "PATCH", body: JSON.stringify({ pinned }) },
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

export const setThreadArchived = async (
  threadId: ThreadId,
  archived: boolean,
): Promise<ThreadData> =>
  (
    await request(
      `/v1/threads/${encodeURIComponent(threadId)}/archive`,
      ArchiveThreadResponseSchema,
      { method: "PATCH", body: JSON.stringify({ archived }) },
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

type SettingsContextRequest =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

export const getSettingsContext = async (
  input: SettingsContextRequest,
  signal?: AbortSignal,
): Promise<SettingsContextData> => {
  if (input.scope === "personal") {
    return (
      await request("/v1/settings/personal", GetSettingsContextResponseSchema, {
        signal,
      })
    ).data;
  }
  return {
    activeScope: "workspace",
    workspace: await getWorkspaceProfile(input.workspaceSlug, signal),
  };
};

export const getPersonalExperimentalFeatures = async (
  signal?: AbortSignal,
): Promise<PersonalExperimentalFeaturesData> =>
  (
    await request(
      "/v1/settings/personal/experimental-features",
      GetPersonalExperimentalFeaturesResponseSchema,
      { signal },
    )
  ).data;

export const updatePersonalExperimentalFeature = async (
  featureId: ExperimentalFeatureId,
  enabled: boolean,
  expectedRevision: ExperimentalFeaturePreferencesRevision,
): Promise<PersonalExperimentalFeaturesData> =>
  (
    await request(
      "/v1/settings/personal/experimental-features",
      UpdatePersonalExperimentalFeatureResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({ featureId, enabled, expectedRevision }),
      },
    )
  ).data;

export type ProjectDefaultsTarget =
  | { readonly scope: "personal" }
  | { readonly scope: "workspace"; readonly workspaceSlug: WorkspaceSlug };

const projectDefaultsPath = (target: ProjectDefaultsTarget) =>
  target.scope === "personal"
    ? "/v1/settings/personal/projects"
    : `/v1/settings/workspaces/${encodeURIComponent(target.workspaceSlug)}/projects`;

export const getProjectDefaults = async (
  target: ProjectDefaultsTarget,
  signal?: AbortSignal,
): Promise<ProjectDefaultsData> =>
  (
    await request(
      projectDefaultsPath(target),
      GetProjectDefaultsResponseSchema,
      {
        signal,
      },
    )
  ).data;

export const updatePersonalProjectDefaults = async (
  expectedRevision: number,
  overrides: ProjectDefaultOverrides,
): Promise<ProjectDefaultsData> =>
  (
    await request(
      "/v1/settings/personal/projects",
      UpdateProjectDefaultsResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({ expectedRevision, overrides }),
      },
    )
  ).data;

export const updateWorkspaceProjectDefaults = async (
  workspaceSlug: WorkspaceSlug,
  expectedRevision: number,
  overrides: ProjectDefaultOverrides,
  policy: WorkspaceProjectPolicy,
): Promise<ProjectDefaultsData> =>
  (
    await request(
      `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/projects`,
      UpdateProjectDefaultsResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({ expectedRevision, overrides, policy }),
      },
    )
  ).data;

export const getSigningKeys = async (
  signal?: AbortSignal,
): Promise<SigningKeysData> =>
  (
    await request("/v1/settings/personal/keys", GetSigningKeysResponseSchema, {
      signal,
    })
  ).data;

export const createManagedSigningKey = async (): Promise<{
  readonly key: NonNullable<SigningKeysData["managedKey"]>;
  readonly setup: SigningKeySetupGuidance;
}> =>
  (
    await request(
      "/v1/settings/personal/keys/managed",
      CreateManagedSigningKeyResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const rotateManagedSigningKey = async (signingKeyId: string) =>
  (
    await request(
      `/v1/settings/personal/keys/managed/${encodeURIComponent(signingKeyId)}/rotate`,
      RotateManagedSigningKeyResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const revokeManagedSigningKey = async (signingKeyId: string) =>
  (
    await request(
      `/v1/settings/personal/keys/managed/${encodeURIComponent(signingKeyId)}`,
      RevokeManagedSigningKeyResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedSigningKeyId;

export const addVerificationKey = async (input: {
  readonly name: string;
  readonly publicKey: string;
}) =>
  (
    await request(
      "/v1/settings/personal/keys/verification",
      AddVerificationKeyResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export const revokeVerificationKey = async (verificationKeyId: string) =>
  (
    await request(
      `/v1/settings/personal/keys/verification/${encodeURIComponent(verificationKeyId)}`,
      RevokeVerificationKeyResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedVerificationKeyId;

export const getWorkspaceProfile = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
): Promise<WorkspaceProfileData> =>
  (
    await request(
      `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}`,
      GetWorkspaceProfileResponseSchema,
      { signal },
    )
  ).data;

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

export const createWorkspace = async (input: {
  readonly displayName: string;
  readonly shortName: string;
}): Promise<WorkspaceProfileData> =>
  (
    await request("/v1/settings/workspaces", CreateWorkspaceResponseSchema, {
      method: "POST",
      body: JSON.stringify(input),
    })
  ).data;

export const updateWorkspaceProfile = async (
  workspaceSlug: WorkspaceSlug,
  input: {
    readonly displayName: string;
    readonly shortName: string;
    readonly expectedRevision: number;
  },
): Promise<WorkspaceProfileData> =>
  (
    await request(
      `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}`,
      UpdateWorkspaceProfileResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const getWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  signal?: AbortSignal,
): Promise<WorkspacePolicyData> =>
  (
    await request(
      `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/policy`,
      GetWorkspacePolicyResponseSchema,
      { signal },
    )
  ).data;

export const updateWorkspacePolicy = async (
  workspaceSlug: WorkspaceSlug,
  expectedRevision: number,
  input: {
    readonly restrictions: WorkspacePolicyRestrictions;
  },
): Promise<WorkspacePolicyData> =>
  (
    await request(
      `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/policy`,
      UpdateWorkspacePolicyResponseSchema,
      {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision,
          restrictions: input.restrictions,
        }),
      },
    )
  ).data;

export const getPersonalAccount = async (
  signal?: AbortSignal,
): Promise<PersonalAccountData> =>
  (
    await request(
      "/v1/settings/personal/account",
      GetPersonalAccountResponseSchema,
      { signal },
    )
  ).data;

export const updatePersonalAccount = async (input: {
  readonly displayName: string;
  readonly username: string;
}): Promise<PersonalAccountData> =>
  (
    await request(
      "/v1/settings/personal/account",
      UpdatePersonalAccountResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const updatePersonalAppearance = async (
  input: UpdatePersonalAppearanceRequest,
): Promise<PersonalAccountData> =>
  (
    await request(
      "/v1/settings/personal/account/appearance",
      UpdatePersonalAppearanceResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const getPersonalComposerDefaults = async (
  signal?: AbortSignal,
): Promise<PersonalComposerDefaultsData> =>
  (
    await request(
      "/v1/settings/personal/account/composer",
      GetPersonalComposerDefaultsResponseSchema,
      { signal },
    )
  ).data;

export const updatePersonalComposerDefaults = async (
  input: UpdatePersonalComposerDefaultsRequest,
): Promise<PersonalComposerDefaultsData> =>
  (
    await request(
      "/v1/settings/personal/account/composer",
      UpdatePersonalComposerDefaultsResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const getPersonalAgentInstructions = async (
  signal?: AbortSignal,
): Promise<PersonalAgentInstructionsData> =>
  (
    await request(
      "/v1/settings/personal/agent-instructions",
      GetPersonalAgentInstructionsResponseSchema,
      { signal },
    )
  ).data;

export const updatePersonalAgentInstructions = async (input: {
  readonly instructions: string;
  readonly expectedRevision: number;
}): Promise<PersonalAgentInstructionsData> =>
  (
    await request(
      "/v1/settings/personal/agent-instructions",
      UpdatePersonalAgentInstructionsResponseSchema,
      { method: "PATCH", body: JSON.stringify(input) },
    )
  ).data;

export const resetPersonalAgentInstructions = async (
  expectedRevision: number,
): Promise<PersonalAgentInstructionsData> =>
  updatePersonalAgentInstructions({ instructions: "", expectedRevision });

export const getPersonalSecurity = async (
  signal?: AbortSignal,
): Promise<PersonalSecurityData> =>
  (
    await request(
      "/v1/settings/personal/security",
      GetPersonalSecurityResponseSchema,
      { signal },
    )
  ).data;

export const listPersonalApiTokens = async (
  signal?: AbortSignal,
): Promise<ReadonlyArray<PersonalApiTokenData>> =>
  (
    await request(
      "/v1/settings/personal/security/tokens",
      ListPersonalApiTokensResponseSchema,
      { signal },
    )
  ).data.items;

export const createPersonalApiToken = async (
  input: CreatePersonalApiTokenRequest,
): Promise<PersonalApiTokenSecretData> =>
  (
    await request(
      "/v1/settings/personal/security/tokens",
      CreatePersonalApiTokenResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export const rotatePersonalApiToken = async (
  tokenId: PersonalApiTokenId,
): Promise<PersonalApiTokenSecretData> =>
  (
    await request(
      `/v1/settings/personal/security/tokens/${encodeURIComponent(tokenId)}/rotate`,
      RotatePersonalApiTokenResponseSchema,
      { method: "POST", body: JSON.stringify({}) },
    )
  ).data;

export const revokePersonalApiToken = async (
  tokenId: PersonalApiTokenId,
): Promise<PersonalApiTokenId> =>
  (
    await request(
      `/v1/settings/personal/security/tokens/${encodeURIComponent(tokenId)}`,
      RevokePersonalApiTokenResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedTokenId;

export interface BrowserSessionPage {
  readonly items: ReadonlyArray<BrowserSessionData>;
  readonly nextOffset?: number;
}

export const listBrowserSessions = async (
  offset?: number,
  signal?: AbortSignal,
): Promise<BrowserSessionPage> => {
  const query = new URLSearchParams({ limit: "25" });
  if (offset !== undefined) query.set("offset", String(offset));
  return (
    await request(
      `/v1/settings/personal/security/sessions?${query}`,
      ListBrowserSessionsResponseSchema,
      { signal },
    )
  ).data;
};

export const revokeBrowserSession = async (
  sessionId: BrowserSessionId,
): Promise<BrowserSessionId> =>
  (
    await request(
      `/v1/settings/personal/security/sessions/${encodeURIComponent(sessionId)}`,
      RevokeBrowserSessionResponseSchema,
      { method: "DELETE" },
    )
  ).data.revokedSessionId;

export const revokeOtherBrowserSessions = async (): Promise<void> => {
  await request(
    "/v1/settings/personal/security/sessions/revoke-others",
    RevokeOtherBrowserSessionsResponseSchema,
    { method: "POST", body: JSON.stringify({}) },
  );
};

export interface PersonalUsageQuery {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
  readonly projectId?: string;
  readonly threadId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly cursor?: string;
  readonly limit?: number;
}

const personalUsageSearch = (input: PersonalUsageQuery) => {
  const query = new URLSearchParams({
    from: input.from,
    to: input.to,
    timezoneOffsetMinutes: String(input.timezoneOffsetMinutes),
  });
  for (const [key, value] of [
    ["projectId", input.projectId],
    ["threadId", input.threadId],
    ["providerId", input.providerId],
    ["modelId", input.modelId],
    ["cursor", input.cursor],
  ] as const) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return query.toString();
};

export const getPersonalUsage = async (
  input: PersonalUsageQuery,
  signal?: AbortSignal,
): Promise<PersonalUsageData> =>
  (
    await request(
      `/v1/settings/personal/usage?${personalUsageSearch(input)}`,
      GetPersonalUsageResponseSchema,
      { signal },
    )
  ).data;

export const exportPersonalUsage = async (
  input: PersonalUsageQuery,
): Promise<PersonalUsageExportData> =>
  (
    await request(
      `/v1/settings/personal/usage/export?${personalUsageSearch(input)}`,
      ExportPersonalUsageResponseSchema,
    )
  ).data;

export interface WorkspaceUsageQuery {
  readonly from: string;
  readonly to: string;
  readonly timezoneOffsetMinutes: number;
  readonly userId?: string;
  readonly projectId?: string;
  readonly providerId?: string;
  readonly modelId?: string;
  readonly ranking: "users" | "projects";
  readonly cursor?: string;
  readonly limit?: number;
}

const workspaceUsageSearch = (input: WorkspaceUsageQuery) => {
  const query = new URLSearchParams({
    from: input.from,
    to: input.to,
    timezoneOffsetMinutes: String(input.timezoneOffsetMinutes),
    ranking: input.ranking,
  });
  for (const [key, value] of [
    ["userId", input.userId],
    ["projectId", input.projectId],
    ["providerId", input.providerId],
    ["modelId", input.modelId],
    ["cursor", input.cursor],
  ] as const) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return query.toString();
};

const workspaceUsagePath = (workspaceSlug: WorkspaceSlug) =>
  `/v1/settings/workspaces/${encodeURIComponent(workspaceSlug)}/usage`;

export const getWorkspaceUsage = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageQuery,
  signal?: AbortSignal,
): Promise<WorkspaceUsageData> =>
  (
    await request(
      `${workspaceUsagePath(workspaceSlug)}?${workspaceUsageSearch(input)}`,
      GetWorkspaceUsageResponseSchema,
      { signal },
    )
  ).data;

export const exportWorkspaceUsage = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageQuery,
): Promise<PersonalUsageExportData> =>
  (
    await request(
      `${workspaceUsagePath(workspaceSlug)}/export?${workspaceUsageSearch(input)}`,
      ExportWorkspaceUsageResponseSchema,
    )
  ).data;

export const inspectWorkspacePrivateThread = async (
  workspaceSlug: WorkspaceSlug,
  input: { readonly threadId: string; readonly reason: string },
): Promise<WorkspacePrivateThreadInspectionData> =>
  (
    await request(
      `${workspaceUsagePath(workspaceSlug)}/private-inspections`,
      InspectWorkspacePrivateThreadResponseSchema,
      { method: "POST", body: JSON.stringify(input) },
    )
  ).data;

export interface WorkspaceUsageAuditQuery {
  readonly from: string;
  readonly to: string;
  readonly actorUserId?: string;
  readonly threadId?: string;
  readonly result?:
    | "success"
    | "permission_denied"
    | "browser_session_required"
    | "recent_authentication_required"
    | "thread_unavailable"
    | "thread_not_private";
  readonly cursor?: string;
  readonly limit?: number;
}

const workspaceUsageAuditSearch = (input: WorkspaceUsageAuditQuery) => {
  const query = new URLSearchParams({ from: input.from, to: input.to });
  for (const [key, value] of [
    ["actorUserId", input.actorUserId],
    ["threadId", input.threadId],
    ["result", input.result],
    ["cursor", input.cursor],
  ] as const) {
    if (value !== undefined && value !== "") query.set(key, value);
  }
  if (input.limit !== undefined) query.set("limit", String(input.limit));
  return query.toString();
};

export const listWorkspaceUsageAudit = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageAuditQuery,
  signal?: AbortSignal,
): Promise<WorkspaceUsageAuditPageData> =>
  (
    await request(
      `${workspaceUsagePath(workspaceSlug)}/audit?${workspaceUsageAuditSearch(input)}`,
      ListWorkspaceUsageAuditResponseSchema,
      { signal },
    )
  ).data;

export const exportWorkspaceUsageAudit = async (
  workspaceSlug: WorkspaceSlug,
  input: WorkspaceUsageAuditQuery,
): Promise<WorkspaceUsageAuditExportData> =>
  (
    await request(
      `${workspaceUsagePath(workspaceSlug)}/audit/export?${workspaceUsageAuditSearch(input)}`,
      ExportWorkspaceUsageAuditResponseSchema,
    )
  ).data;
