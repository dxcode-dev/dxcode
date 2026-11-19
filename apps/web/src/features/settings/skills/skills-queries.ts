import {
  DecideSkillProposalResponseSchema,
  type DirectorySkillData,
  DiscoverSkillsResponseSchema,
  ExportSkillResponseSchema,
  ImportSkillResponseSchema,
  InstallSkillResponseSchema,
  ListSkillsResponseSchema,
  PreviewSkillResponseSchema,
  PreviewSkillSourceResponseSchema,
  PublishSkillVersionResponseSchema,
  RemoveSkillResponseSchema,
  type SkillData,
  SkillFileResponseSchema,
  type SkillInstallSource,
  type SkillProposalData,
  UpdateSkillStateResponseSchema,
  UpdateSkillWorkspacePolicyResponseSchema,
} from "@dx/api";
import type {
  SkillId,
  SkillImportBundle,
  SkillIntegrity,
  SkillVersion,
  UserId,
} from "@dx/domain";
import { type QueryClient, queryOptions } from "@tanstack/react-query";
import { request, type SkillsTarget } from "../../../shared/api/client.js";

export type {
  DirectorySkillData,
  SkillData,
  SkillInstallSource,
  SkillProposalData,
  SkillsTarget,
};

// The skills API lives with the Skills settings, not in the shared client,
// so the Thread page's first load doesn't carry its schemas.
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
  enabled = false,
): Promise<SkillData> =>
  (
    await request(skillsBase(target), ImportSkillResponseSchema, {
      method: "POST",
      body: JSON.stringify({ bundle, reviewedIntegrity, enabled }),
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

/** Saves an agent's skill proposal the person reviewed. */
export const approveSkillProposal = async (
  target: SkillsTarget,
  proposalId: string,
  reviewedIntegrity: SkillIntegrity,
) =>
  (
    await request(
      `${skillsBase(target)}/proposals/${encodeURIComponent(proposalId)}/approve`,
      DecideSkillProposalResponseSchema,
      { method: "POST", body: JSON.stringify({ reviewedIntegrity }) },
    )
  ).data;

export const rejectSkillProposal = async (
  target: SkillsTarget,
  proposalId: string,
) =>
  (
    await request(
      `${skillsBase(target)}/proposals/${encodeURIComponent(proposalId)}/reject`,
      DecideSkillProposalResponseSchema,
      { method: "POST", body: "{}" },
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

/** skills.sh's most installed skills, or its matches for `query`. */
export const discoverSkills = async (
  target: SkillsTarget,
  query: string,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${skillsBase(target)}/discover?${new URLSearchParams({ q: query })}`,
      DiscoverSkillsResponseSchema,
      { signal },
    )
  ).data.items;

/** A skill from skills.sh or GitHub with all its files, before install. */
export const previewSkillSource = async (
  target: SkillsTarget,
  source: SkillInstallSource,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${skillsBase(target)}/sources/preview`,
      PreviewSkillSourceResponseSchema,
      { method: "POST", body: JSON.stringify({ source }), signal },
    )
  ).data;

export type SkillSourcePreview = Awaited<ReturnType<typeof previewSkillSource>>;

/** Installs a reviewed skill from skills.sh or GitHub, switched on. */
export const installSkill = async (
  target: SkillsTarget,
  source: SkillInstallSource,
  reviewedIntegrity: SkillIntegrity,
): Promise<SkillData> =>
  (
    await request(`${skillsBase(target)}/install`, InstallSkillResponseSchema, {
      method: "POST",
      body: JSON.stringify({ source, reviewedIntegrity }),
    })
  ).data;

/** One file of a skill's active version. */
export const readSkillFile = async (
  target: SkillsTarget,
  skillId: SkillId,
  path: string,
  signal?: AbortSignal,
) =>
  (
    await request(
      `${skillsBase(target)}/${encodeURIComponent(skillId)}/files?${new URLSearchParams({ path })}`,
      SkillFileResponseSchema,
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
