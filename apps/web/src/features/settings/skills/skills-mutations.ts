import type { SkillImportBundle, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  exportSkill,
  importSkill,
  previewSkill,
  publishSkillVersion,
  removeSkill,
  updateSkillState,
  updateSkillWorkspacePolicy,
} from "../../../shared/api/client.js";
import {
  type SkillData,
  type SkillsTarget,
  skillKeys,
} from "./skills-queries.js";

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

const firstFieldError = (error: unknown) =>
  error instanceof ApiError ? error.fieldErrors?.[0] : undefined;

/**
 * The server's field message when it sent one, after the file it names, else
 * the error's own.
 */
export const skillErrorMessage = (error: unknown) => {
  const field = firstFieldError(error);
  if (field !== undefined)
    return /[./]/.test(field.field)
      ? `${field.field}: ${field.message}`
      : field.message;
  return error instanceof Error ? error.message : "Request failed.";
};

/** The form field a save failure belongs to, if any. */
export const skillErrorField = (error: unknown) =>
  firstFieldError(error)?.field === "name" ? ("name" as const) : undefined;

export interface SkillSaveFailure {
  readonly message: string;
  readonly field?: "name";
}

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

/** What the New Skill and Edit forms write. */
export interface SkillDraft {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}

const textFile = (path: string, mediaType: string, content: string) => ({
  path,
  kind: "file" as const,
  mediaType,
  encoding: "utf-8" as const,
  content,
});

/**
 * Saves a form-written skill. A new skill is created and switched on, so
 * saving publishes it; an edit publishes the next version with the existing
 * resource files and MCP dependencies, active unless the skill is pinned.
 */
const authorSkill = async (
  target: SkillsTarget,
  draft: SkillDraft,
  skill: SkillData | undefined,
) => {
  const resources =
    skill === undefined || skill.active.resources.length === 0
      ? []
      : (await exportSkill(target, skill.id)).files.filter(
          ({ path }) => path !== "skill.json" && path !== "instructions.md",
        );
  const bundle = {
    source: {
      type: "browser-files",
      label: skill === undefined ? "Created in settings" : "Edited in settings",
    },
    files: [
      textFile(
        "skill.json",
        "application/json",
        `${JSON.stringify(
          {
            schemaVersion: 1,
            name: skill?.name ?? draft.name,
            description: draft.description.trim(),
            mcpServerIds: skill?.active.manifest.mcpServerIds ?? [],
          },
          null,
          2,
        )}\n`,
      ),
      textFile(
        "instructions.md",
        "text/markdown",
        `${draft.instructions.trim()}\n`,
      ),
      ...resources,
    ],
  } as SkillImportBundle;
  const { integrity } = await previewSkill(target, bundle);
  if (skill !== undefined) {
    return await publishSkillVersion(
      target,
      skill.id,
      bundle,
      integrity,
      !skill.pinned,
    );
  }
  return await importSkill(target, bundle, integrity, true);
};

export const skillAuthorMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: SkillsTarget,
) =>
  mutationOptions({
    mutationKey: [...skillKeys.list(userId, target), "author"],
    gcTime: 0,
    mutationFn: ({
      draft,
      skill,
    }: {
      readonly draft: SkillDraft;
      readonly skill?: SkillData;
    }) => authorSkill(target, draft, skill),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: skillKeys.list(userId, target),
      }),
  });
