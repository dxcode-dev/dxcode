import type { SettingsScope } from "@dx/domain";
import type { ComponentType, SVGProps } from "react";
import { describe, expect, it } from "vitest";
import {
  createSettingsManifest,
  resolveSettingsSection,
  settingsPath,
  type SettingsSectionRegistration,
} from "./settings-registration.js";

const Empty = () => null;
const Icon = Empty as ComponentType<SVGProps<SVGSVGElement>>;
const registration = (
  scope: SettingsScope,
  id: string,
  slug?: string,
): SettingsSectionRegistration => ({
  scope,
  id,
  slug,
  label: id,
  title: id,
  description: id,
  icon: Icon,
  component: Empty,
});

describe("settings registration", () => {
  const manifest = createSettingsManifest([
    registration("personal", "account"),
    registration("personal", "advanced", "advanced"),
    registration("workspace", "workspace"),
    registration("workspace", "workspace-advanced", "advanced"),
  ]);

  it("resolves root and deep-link sections from one manifest", () => {
    expect(
      resolveSettingsSection(manifest, "personal", undefined),
    ).toMatchObject({ found: true, registration: { id: "account" } });
    expect(
      resolveSettingsSection(manifest, "workspace", "advanced"),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-advanced" },
    });
    expect(resolveSettingsSection(manifest, "personal", "missing")).toEqual({
      found: false,
      error: {
        code: "SETTINGS_SECTION_NOT_FOUND",
        scope: "personal",
        section: "missing",
      },
    });
  });

  it("rejects duplicate and rootless feature registrations", () => {
    expect(() =>
      createSettingsManifest([
        registration("personal", "account"),
        registration("personal", "duplicate"),
        registration("workspace", "workspace"),
      ]),
    ).toThrow("Duplicate settings route");
    expect(() =>
      createSettingsManifest([
        registration("personal", "account"),
        registration("workspace", "advanced", "advanced"),
      ]),
    ).toThrow("Missing workspace settings root");
    expect(() =>
      createSettingsManifest([
        registration("personal", "account"),
        registration("personal", "invalid", "Not Valid"),
        registration("workspace", "workspace"),
      ]),
    ).toThrow("Invalid settings route slug");
  });

  it("builds canonical personal and workspace paths", () => {
    expect(settingsPath({ scope: "personal" })).toBe("/settings");
    expect(settingsPath({ scope: "personal", section: "advanced" })).toBe(
      "/settings/advanced",
    );
    expect(
      settingsPath({
        scope: "workspace",
        workspaceSlug: "dx-team" as never,
        section: "advanced",
      }),
    ).toBe("/workspaces/dx-team/advanced");
  });
});
