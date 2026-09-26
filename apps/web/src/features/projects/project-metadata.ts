import {
  isValidProjectName,
  normalizeProjectName,
  PROJECT_NAME_HELP,
} from "@dx/domain";

export const buildProjectMetadataChanges = (
  currentName: string,
  draftName: string,
  description: string,
) => {
  if (draftName === currentName)
    return { ok: true as const, changes: { description } };

  const name = normalizeProjectName(draftName);
  if (!isValidProjectName(name))
    return { ok: false as const, error: PROJECT_NAME_HELP };

  return { ok: true as const, changes: { name, description } };
};
