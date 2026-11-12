import {
  DecideSkillProposalResponseSchema,
  ExportSkillResponseSchema,
  ImportSkillResponseSchema,
  ListSkillsResponseSchema,
  PreviewSkillResponseSchema,
  PublishSkillVersionResponseSchema,
  RemoveSkillResponseSchema,
  type SkillData,
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
import { queryOptions } from "@tanstack/react-query";
import { request, type SkillsTarget } from "../../../shared/api/client.js";

export type { SkillData, SkillProposalData, SkillsTarget };

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

export const skillKeys = {
  all: (userId: UserId) => ["skills", userId] as const,
  list: (userId: UserId, target: SkillsTarget) =>
    [...skillKeys.all(userId), target] as const,
};

export const skillsQueryOptions = (userId: UserId, target: SkillsTarget) =>
  queryOptions({
    queryKey: skillKeys.list(userId, target),
    queryFn: ({ signal }) => listSkills(target, signal),
    staleTime: 15_000,
    gcTime: 5 * 60_000,
    refetchOnWindowFocus: true,
  });
