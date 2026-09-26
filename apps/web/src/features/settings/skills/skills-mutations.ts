import type { UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  exportSkill,
  importSkill,
  previewSkill,
  publishSkillVersion,
  removeSkill,
  updateSkillState,
  updateSkillWorkspacePolicy,
} from "../../../shared/api/client.js";
import { type SkillsTarget, skillKeys } from "./skills-queries.js";

export type SkillsMutationAction =
  | {
      readonly type: "import";
      readonly bundle: Parameters<typeof importSkill>[1];
      readonly reviewedIntegrity: Parameters<typeof importSkill>[2];
    }
  | {
      readonly type: "publishVersion";
      readonly skillId: Parameters<typeof publishSkillVersion>[1];
      readonly bundle: Parameters<typeof publishSkillVersion>[2];
      readonly reviewedIntegrity: Parameters<typeof publishSkillVersion>[3];
      readonly activate: boolean;
    }
  | {
      readonly type: "updateState";
      readonly skillId: Parameters<typeof updateSkillState>[1];
      readonly input: Parameters<typeof updateSkillState>[2];
    }
  | {
      readonly type: "remove";
      readonly skillId: Parameters<typeof removeSkill>[1];
    }
  | { readonly type: "updatePolicy"; readonly allowPersonalSkills: boolean };

export type SkillPreview = Awaited<ReturnType<typeof previewSkill>>;

const mutateSkills = async (
  target: SkillsTarget,
  action: SkillsMutationAction,
) => {
  switch (action.type) {
    case "import":
      return await importSkill(target, action.bundle, action.reviewedIntegrity);
    case "publishVersion":
      return await publishSkillVersion(
        target,
        action.skillId,
        action.bundle,
        action.reviewedIntegrity,
        action.activate,
      );
    case "updateState":
      return await updateSkillState(target, action.skillId, action.input);
    case "remove":
      return await removeSkill(target, action.skillId);
    case "updatePolicy": {
      if (target.scope !== "workspace")
        throw new Error("Skill workspace policy requires a workspace target.");
      return await updateSkillWorkspacePolicy(
        target,
        action.allowPersonalSkills,
      );
    }
  }
};

export const skillsMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: SkillsTarget,
) =>
  mutationOptions({
    mutationKey: [...skillKeys.list(userId, target), "mutate"],
    gcTime: 0,
    mutationFn: (action: SkillsMutationAction) => mutateSkills(target, action),
    onSuccess: () =>
      queryClient.invalidateQueries({
        queryKey: skillKeys.list(userId, target),
      }),
  });

export const skillPreviewMutationOptions = (
  userId: UserId,
  target: SkillsTarget,
) =>
  mutationOptions({
    mutationKey: [...skillKeys.list(userId, target), "preview"],
    mutationFn: (bundle: Parameters<typeof previewSkill>[1]) =>
      previewSkill(target, bundle),
    gcTime: 0,
    onSuccess: () => undefined,
  });

export const skillExportMutationOptions = (
  userId: UserId,
  target: SkillsTarget,
) =>
  mutationOptions({
    mutationKey: [...skillKeys.list(userId, target), "export"],
    mutationFn: (skillId: Parameters<typeof exportSkill>[1]) =>
      exportSkill(target, skillId),
    gcTime: 0,
    onSuccess: () => undefined,
  });
