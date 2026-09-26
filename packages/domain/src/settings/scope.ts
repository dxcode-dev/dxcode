import { Schema } from "effect";
import {
  WorkspaceMembership,
  WorkspaceRole,
  WorkspaceSlug as WorkspaceSlugSchema,
} from "./workspace.js";

export const SettingsScope = Schema.Literals(["personal", "workspace"]);

export type SettingsScope = typeof SettingsScope.Type;

export const SettingsSectionSlug = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(63),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/),
);

export type SettingsSectionSlug = typeof SettingsSectionSlug.Type;

export const WorkspaceSlug = WorkspaceSlugSchema;

export type WorkspaceSlug = typeof WorkspaceSlug.Type;

export const SettingsWorkspaceRole = WorkspaceRole;

export type SettingsWorkspaceRole = typeof SettingsWorkspaceRole.Type;

export const SettingsWorkspaceMembership = WorkspaceMembership;

export type SettingsWorkspaceMembership =
  typeof SettingsWorkspaceMembership.Type;
