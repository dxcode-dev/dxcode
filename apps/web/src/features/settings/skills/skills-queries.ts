import {
  ApprovePersonalSkillProposalEndpoint,
  ApproveWorkspaceSkillProposalEndpoint,
  type DirectorySkillData,
  DiscoverPersonalSkillsEndpoint,
  DiscoverWorkspaceSkillsEndpoint,
  ExportPersonalSkillEndpoint,
  ExportWorkspaceSkillEndpoint,
  ImportPersonalSkillEndpoint,
  ImportWorkspaceSkillEndpoint,
  InstallPersonalSkillEndpoint,
  InstallWorkspaceSkillEndpoint,
  ListPersonalSkillsEndpoint,
  ListWorkspaceSkillsEndpoint,
  PreviewPersonalSkillEndpoint,
  PreviewPersonalSkillSourceEndpoint,
  PreviewWorkspaceSkillEndpoint,
  PreviewWorkspaceSkillSourceEndpoint,
  PublishPersonalSkillVersionEndpoint,
  PublishWorkspaceSkillVersionEndpoint,
  ReadPersonalSkillFileEndpoint,
  ReadWorkspaceSkillFileEndpoint,
  RejectPersonalSkillProposalEndpoint,
  RejectWorkspaceSkillProposalEndpoint,
  RemovePersonalSkillEndpoint,
  RemoveWorkspaceSkillEndpoint,
  type SkillData,
  type SkillInstallSource,
  type SkillProposalData,
  type SkillProposalParamsSchema,
  UpdatePersonalSkillStateEndpoint,
  UpdateWorkspaceSkillPolicyEndpoint,
  UpdateWorkspaceSkillStateEndpoint,
} from "@dx/api";
import type {
  SkillId,
  SkillImportBundle,
  SkillIntegrity,
  SkillVersion,
  UserId,
} from "@dx/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { dxClient, type SkillsTarget } from "../../../shared/api/client.js";

export type {
  DirectorySkillData,
  SkillData,
  SkillInstallSource,
  SkillProposalData,
  SkillsTarget,
};

// The skills API lives with the Skills settings, not in the shared client,
// so the Thread page's first load doesn't carry its schemas.
const workspace = (target: Extract<SkillsTarget, { scope: "workspace" }>) => ({
  workspaceSlug: target.workspaceSlug,
});

export const listSkills = async (target: SkillsTarget, signal?: AbortSignal) =>
  (target.scope === "personal"
    ? await dxClient.call(ListPersonalSkillsEndpoint, {}, { signal })
    : await dxClient.call(
        ListWorkspaceSkillsEndpoint,
        { params: workspace(target) },
        { signal },
      )
  ).data;

export const previewSkill = async (
  target: SkillsTarget,
  bundle: SkillImportBundle,
) =>
  (target.scope === "personal"
    ? await dxClient.call(PreviewPersonalSkillEndpoint, { body: bundle })
    : await dxClient.call(PreviewWorkspaceSkillEndpoint, {
        params: workspace(target),
        body: bundle,
      })
  ).data;

export const importSkill = async (
  target: SkillsTarget,
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
  enabled = false,
): Promise<SkillData> => {
  const body = { bundle, reviewedIntegrity, enabled };
  return (
    target.scope === "personal"
      ? await dxClient.call(ImportPersonalSkillEndpoint, { body })
      : await dxClient.call(ImportWorkspaceSkillEndpoint, {
          params: workspace(target),
          body,
        })
  ).data;
};

export const publishSkillVersion = async (
  target: SkillsTarget,
  skillId: SkillId,
  bundle: SkillImportBundle,
  reviewedIntegrity: SkillIntegrity,
  activate: boolean,
): Promise<SkillData> => {
  const body = { bundle, reviewedIntegrity, activate };
  return (
    target.scope === "personal"
      ? await dxClient.call(PublishPersonalSkillVersionEndpoint, {
          params: { skillId },
          body,
        })
      : await dxClient.call(PublishWorkspaceSkillVersionEndpoint, {
          params: { ...workspace(target), skillId },
          body,
        })
  ).data;
};

export const updateSkillState = async (
  target: SkillsTarget,
  skillId: SkillId,
  input: {
    readonly enabled?: boolean;
    readonly activeVersion?: SkillVersion;
    readonly pinned?: boolean;
  },
): Promise<SkillData> =>
  (target.scope === "personal"
    ? await dxClient.call(UpdatePersonalSkillStateEndpoint, {
        params: { skillId },
        body: input,
      })
    : await dxClient.call(UpdateWorkspaceSkillStateEndpoint, {
        params: { ...workspace(target), skillId },
        body: input,
      })
  ).data;

export const removeSkill = async (target: SkillsTarget, skillId: SkillId) =>
  (target.scope === "personal"
    ? await dxClient.call(RemovePersonalSkillEndpoint, { params: { skillId } })
    : await dxClient.call(RemoveWorkspaceSkillEndpoint, {
        params: { ...workspace(target), skillId },
      })
  ).data.removedSkillId;

export const exportSkill = async (
  target: SkillsTarget,
  skillId: SkillId,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(
        ExportPersonalSkillEndpoint,
        { params: { skillId } },
        { signal },
      )
    : await dxClient.call(
        ExportWorkspaceSkillEndpoint,
        { params: { ...workspace(target), skillId } },
        { signal },
      )
  ).data;

/** Callers pass the id they read; Core refuses one it cannot find. */
const proposalParams = (proposalId: string) => ({
  proposalId:
    proposalId as (typeof SkillProposalParamsSchema.Type)["proposalId"],
});

/** Saves an agent's skill proposal the person reviewed. */
export const approveSkillProposal = async (
  target: SkillsTarget,
  proposalId: string,
  reviewedIntegrity: SkillIntegrity,
) =>
  (target.scope === "personal"
    ? await dxClient.call(ApprovePersonalSkillProposalEndpoint, {
        params: proposalParams(proposalId),
        body: { reviewedIntegrity },
      })
    : await dxClient.call(ApproveWorkspaceSkillProposalEndpoint, {
        params: { ...workspace(target), ...proposalParams(proposalId) },
        body: { reviewedIntegrity },
      })
  ).data;

export const rejectSkillProposal = async (
  target: SkillsTarget,
  proposalId: string,
) =>
  (target.scope === "personal"
    ? await dxClient.call(RejectPersonalSkillProposalEndpoint, {
        params: proposalParams(proposalId),
        body: {},
      })
    : await dxClient.call(RejectWorkspaceSkillProposalEndpoint, {
        params: { ...workspace(target), ...proposalParams(proposalId) },
        body: {},
      })
  ).data;

export const updateSkillWorkspacePolicy = async (
  target: Extract<SkillsTarget, { readonly scope: "workspace" }>,
  allowPersonalSkills: boolean,
) =>
  (
    await dxClient.call(UpdateWorkspaceSkillPolicyEndpoint, {
      params: workspace(target),
      body: { allowPersonalSkills },
    })
  ).data;

/** skills.sh's most installed skills, or its matches for `query`. */
export const discoverSkills = async (
  target: SkillsTarget,
  query: string,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(
        DiscoverPersonalSkillsEndpoint,
        { query: { q: query } },
        { signal },
      )
    : await dxClient.call(
        DiscoverWorkspaceSkillsEndpoint,
        { params: workspace(target), query: { q: query } },
        { signal },
      )
  ).data.items;

/** A skill from skills.sh or GitHub with all its files, before install. */
export const previewSkillSource = async (
  target: SkillsTarget,
  source: SkillInstallSource,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(
        PreviewPersonalSkillSourceEndpoint,
        { body: { source } },
        { signal },
      )
    : await dxClient.call(
        PreviewWorkspaceSkillSourceEndpoint,
        { params: workspace(target), body: { source } },
        { signal },
      )
  ).data;

export type SkillSourcePreview = Awaited<ReturnType<typeof previewSkillSource>>;

/** Installs a reviewed skill from skills.sh or GitHub, switched on. */
export const installSkill = async (
  target: SkillsTarget,
  source: SkillInstallSource,
  reviewedIntegrity: SkillIntegrity,
): Promise<SkillData> =>
  (target.scope === "personal"
    ? await dxClient.call(InstallPersonalSkillEndpoint, {
        body: { source, reviewedIntegrity },
      })
    : await dxClient.call(InstallWorkspaceSkillEndpoint, {
        params: workspace(target),
        body: { source, reviewedIntegrity },
      })
  ).data;

/** One file of a skill's active version. */
export const readSkillFile = async (
  target: SkillsTarget,
  skillId: SkillId,
  path: string,
  signal?: AbortSignal,
) =>
  (target.scope === "personal"
    ? await dxClient.call(
        ReadPersonalSkillFileEndpoint,
        { params: { skillId }, query: { path } },
        { signal },
      )
    : await dxClient.call(
        ReadWorkspaceSkillFileEndpoint,
        { params: { ...workspace(target), skillId }, query: { path } },
        { signal },
      )
  ).data;

export const skillKeys = {
  all: (userId: UserId) => ["skills", userId] as const,
  list: (userId: UserId, target: SkillsTarget) =>
    [...skillKeys.all(userId), target] as const,
  discover: (userId: UserId, query: string) =>
    [...skillKeys.all(userId), "discover", query] as const,
  source: (userId: UserId, target: SkillsTarget, source: SkillInstallSource) =>
    [...skillKeys.list(userId, target), "source", source] as const,
  file: (
    userId: UserId,
    target: SkillsTarget,
    skillId: SkillId,
    version: SkillVersion,
    path: string,
  ) =>
    [
      ...skillKeys.list(userId, target),
      "file",
      skillId,
      version,
      path,
    ] as const,
};

/** A skills.sh skill's install count, from any Discover list already read. */
export const cachedDirectoryInstalls = (
  queryClient: QueryClient,
  userId: UserId,
  id: string,
) =>
  queryClient
    .getQueriesData<ReadonlyArray<DirectorySkillData>>({
      queryKey: [...skillKeys.all(userId), "discover"],
    })
    .flatMap(([, items]) => items ?? [])
    .find((item) => item.id === id)?.installs;

export const discoverQueryOptions = (
  userId: UserId,
  target: SkillsTarget,
  query: string,
) =>
  queryOptions({
    queryKey: skillKeys.discover(userId, query),
    queryFn: ({ signal }) => discoverSkills(target, query, signal),
    // skills.sh's lists change slowly: one read per query per ten minutes,
    // not one per tab switch or window focus.
    staleTime: 10 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
  });

export const sourcePreviewQueryOptions = (
  userId: UserId,
  target: SkillsTarget,
  source: SkillInstallSource,
) =>
  queryOptions({
    queryKey: skillKeys.source(userId, target, source),
    queryFn: ({ signal }) => previewSkillSource(target, source, signal),
    staleTime: 30 * 60_000,
    gcTime: 30 * 60_000,
    refetchOnWindowFocus: false,
    retry: false,
  });

/** A file's content; versions never change, so it never goes stale. */
export const skillFileQueryOptions = (
  userId: UserId,
  target: SkillsTarget,
  skillId: SkillId,
  version: SkillVersion,
  path: string,
) =>
  queryOptions({
    queryKey: skillKeys.file(userId, target, skillId, version, path),
    queryFn: ({ signal }) => readSkillFile(target, skillId, path, signal),
    staleTime: Number.POSITIVE_INFINITY,
  });

export const skillsQueryOptions = (userId: UserId, target: SkillsTarget) =>
  queryOptions({
    queryKey: skillKeys.list(userId, target),
    queryFn: ({ signal }) => listSkills(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
