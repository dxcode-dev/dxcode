/** The sections `/projects/$projectId/settings/$section` can open. */
export const projectSettingsSectionIds = ["general", "orb", "secrets"] as const;

export type ProjectSettingsSection = (typeof projectSettingsSectionIds)[number];

export const isProjectSettingsSection = (
  section: string | undefined,
): section is ProjectSettingsSection =>
  projectSettingsSectionIds.some((id) => id === section);
