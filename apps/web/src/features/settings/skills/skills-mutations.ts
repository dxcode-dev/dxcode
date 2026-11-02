import type { SkillImportBundle, UserId } from "@dx/domain";
import { mutationOptions, type QueryClient } from "@tanstack/react-query";
import {
  ApiError,
  exportSkill,
  importSkill,
  type listSkills,
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

type SkillList = Awaited<ReturnType<typeof listSkills>>;

/** Replaces one skill in the cached list, leaving the rest as they are. */
const replaceSkill = (
  queryClient: QueryClient,
  userId: UserId,
  target: SkillsTarget,
  skill: SkillData,
) =>
  queryClient.setQueryData<SkillList>(skillKeys.list(userId, target), (list) =>
    list === undefined
      ? list
      : {
          ...list,
          items: list.items.map((item) =>
            item.id === skill.id ? skill : item,
          ),
        },
  );

/**
 * Rereads the list once the last of these writes settles, so the labels
 * other skills derive from this one (such as a workspace skill replaced by a
 * personal one of the same name) catch up.
 */
const rereadAfterLast = async (
  queryClient: QueryClient,
  userId: UserId,
  target: SkillsTarget,
  mutationKey: ReadonlyArray<unknown>,
) => {
  if (queryClient.isMutating({ mutationKey, exact: true }) === 1)
    await queryClient.invalidateQueries({
      queryKey: skillKeys.list(userId, target),
      exact: true,
    });
};

export interface SkillToggle {
  readonly skill: SkillData;
  readonly enabled: boolean;
}

export const skillToggleMutationKey = (userId: UserId, target: SkillsTarget) =>
  [...skillKeys.list(userId, target), "toggle"] as const;

/**
 * Switches a skill on or off. The switch moves at once; a failed save puts
 * that skill back as it was, and callers show the error.
 */
export const skillToggleMutationOptions = (
  queryClient: QueryClient,
  userId: UserId,
  target: SkillsTarget,
) =>
  mutationOptions({
    mutationKey: skillToggleMutationKey(userId, target),
    gcTime: 0,
    mutationFn: ({ skill, enabled }: SkillToggle) =>
      updateSkillState(target, skill.id, { enabled }),
    onMutate: async ({ skill, enabled }) => {
      // A read that started before the save must not land after it.
      await queryClient.cancelQueries({
        queryKey: skillKeys.list(userId, target),
        exact: true,
      });
      replaceSkill(queryClient, userId, target, {
        ...skill,
        enabled,
        effectiveState: enabled ? "effective" : "disabled",
      });
    },
    onSuccess: (saved) => replaceSkill(queryClient, userId, target, saved),
    onError: (_error, { skill }) =>
      replaceSkill(queryClient, userId, target, skill),
    onSettled: () =>
      rereadAfterLast(
        queryClient,
        userId,
        target,
        skillToggleMutationKey(userId, target),
      ),
  });

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
    // An edit shows its new version at once; a failed save puts the skill
    // back as it was.
    onMutate: async ({ draft, skill }) => {
      if (skill === undefined) return;
      await queryClient.cancelQueries({
        queryKey: skillKeys.list(userId, target),
        exact: true,
      });
      replaceSkill(queryClient, userId, target, editedSkill(skill, draft));
    },
    onSuccess: (saved) => replaceSkill(queryClient, userId, target, saved),
    onError: (_error, { skill }) => {
      if (skill !== undefined) replaceSkill(queryClient, userId, target, skill);
    },
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: skillKeys.list(userId, target),
      }),
  });

/**
 * The skill as the server will hold it once an edit saves: the next version,
 * active unless the skill is pinned.
 */
const editedSkill = (skill: SkillData, draft: SkillDraft): SkillData => {
  const version = (Math.max(...skill.versions) +
    1) as SkillData["activeVersion"];
  return {
    ...skill,
    versions: [version, ...skill.versions],
    ...(skill.pinned
      ? {}
      : {
          activeVersion: version,
          active: {
            ...skill.active,
            version,
            manifest: {
              ...skill.active.manifest,
              description:
                draft.description.trim() as SkillData["active"]["manifest"]["description"],
            },
            instructions: `${draft.instructions.trim()}\n`,
          },
        }),
  };
};
