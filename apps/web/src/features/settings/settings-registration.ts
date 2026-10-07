import type { WorkspaceProfileData } from "@dx/api";
import {
  type SettingsScope,
  SettingsSectionSlug,
  type WorkspaceSlug,
} from "@dx/domain";
import { Option, Schema } from "effect";
import type { ComponentType, SVGProps } from "react";

export interface SettingsSectionProps {
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly settingsReturnTo?: string;
  readonly workspace?: WorkspaceProfileData;
  readonly workspaceSlug?: WorkspaceSlug;
  readonly onWorkspaceChanged?: (workspace: WorkspaceProfileData) => void;
}

export interface SettingsSectionRegistration {
  readonly id: string;
  readonly scope: SettingsScope;
  readonly slug?: SettingsSectionSlug;
  readonly label: string;
  readonly title: string;
  readonly description: string;
  readonly icon: ComponentType<SVGProps<SVGSVGElement>>;
  readonly component: ComponentType<SettingsSectionProps>;
  /** Hidden from workspace members who are not admins. */
  readonly adminOnly?: boolean;
}

export interface SettingsRouteNotFound {
  readonly code: "SETTINGS_SECTION_NOT_FOUND";
  readonly scope: SettingsScope;
  readonly section: string;
}

export interface SettingsManifest {
  readonly registrations: ReadonlyArray<SettingsSectionRegistration>;
  readonly personal: ReadonlyArray<SettingsSectionRegistration>;
  readonly workspace: ReadonlyArray<SettingsSectionRegistration>;
}

export const createSettingsManifest = (
  registrations: ReadonlyArray<SettingsSectionRegistration>,
): SettingsManifest => {
  const seen = new Set<string>();
  const roots = new Set<SettingsScope>();
  for (const registration of registrations) {
    if (
      registration.slug !== undefined &&
      Option.isNone(
        Schema.decodeUnknownOption(SettingsSectionSlug)(registration.slug),
      )
    ) {
      throw new Error(`Invalid settings route slug: ${registration.slug}`);
    }
    const key = `${registration.scope}:${registration.slug ?? "<root>"}`;
    if (seen.has(key)) throw new Error(`Duplicate settings route: ${key}`);
    seen.add(key);
    if (registration.slug === undefined) roots.add(registration.scope);
  }
  for (const scope of ["personal", "workspace"] as const) {
    if (!roots.has(scope)) throw new Error(`Missing ${scope} settings root.`);
  }
  const frozen = Object.freeze([...registrations]);
  return Object.freeze({
    registrations: frozen,
    personal: Object.freeze(
      frozen.filter((registration) => registration.scope === "personal"),
    ),
    workspace: Object.freeze(
      frozen.filter((registration) => registration.scope === "workspace"),
    ),
  });
};

export const resolveSettingsSection = (
  manifest: SettingsManifest,
  scope: SettingsScope,
  section: string | undefined,
):
  | { readonly found: true; readonly registration: SettingsSectionRegistration }
  | { readonly found: false; readonly error: SettingsRouteNotFound } => {
  const registrations =
    scope === "personal" ? manifest.personal : manifest.workspace;
  const registration = registrations.find((candidate) =>
    section === undefined
      ? candidate.slug === undefined
      : candidate.slug === section,
  );
  return registration === undefined
    ? {
        found: false,
        error: {
          code: "SETTINGS_SECTION_NOT_FOUND",
          scope,
          section: section ?? "root",
        },
      }
    : { found: true, registration };
};

type SettingsPathInput =
  | {
      readonly scope: "personal";
      readonly section?: string;
    }
  | {
      readonly scope: "workspace";
      readonly workspaceSlug: WorkspaceSlug;
      readonly section?: string;
    };

export const settingsPath = (input: SettingsPathInput): string => {
  const root =
    input.scope === "personal"
      ? "/settings"
      : `/workspaces/${encodeURIComponent(input.workspaceSlug)}`;
  return input.section === undefined
    ? root
    : `${root}/${encodeURIComponent(input.section)}`;
};
