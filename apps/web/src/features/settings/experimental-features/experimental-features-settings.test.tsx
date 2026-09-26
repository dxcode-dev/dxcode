import {
  type PersonalExperimentalFeaturesData,
  PersonalExperimentalFeaturesDataSchema,
} from "@dx/api";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { settingsManifest } from "../foundation-sections.js";
import {
  resolveSettingsSection,
  settingsPath,
} from "../settings-registration.js";
import {
  ExperimentalFeaturesErrorState,
  ExperimentalFeaturesPanel,
} from "./experimental-features-settings.js";

const data = (
  input: { readonly flags?: ReadonlyArray<unknown> } = {},
): PersonalExperimentalFeaturesData =>
  Schema.decodeUnknownSync(PersonalExperimentalFeaturesDataSchema)({
    registryVersion: 1,
    revision: 0,
    flags: input.flags ?? [],
  });

const fixtureFlag = {
  registration: {
    id: "fixture-capability-preview",
    title: "Fixture capability preview",
    description: "Exercises the server-side capability evaluator.",
    owner: {
      team: "dx/settings",
      issue: "https://github.com/ravindrabarthwal/dx/issues/48",
    },
    status: "experimental",
    defaultEnabled: false,
    allowedScope: "personal",
    kind: "capability",
    risk: "medium",
    prerequisites: [],
    incompatibilities: [],
    activation: "new-thread",
    reviewDate: "2026-12-01",
    lifecyclePlan: {
      migration: "Clean the stale preference.",
      graduation: "Remove the evaluator call.",
      removal: "Delete the fixture capability.",
    },
  },
  personalEnabled: true,
  preferenceSource: "personal",
  effectiveEnabled: true,
  blockedBy: [],
};

describe("experimental feature settings", () => {
  it("registers the exact personal route without moving Advanced", () => {
    expect(
      settingsPath({ scope: "personal", section: "experimental-features" }),
    ).toBe("/settings/experimental-features");
    expect(
      resolveSettingsSection(
        settingsManifest,
        "personal",
        "experimental-features",
      ),
    ).toMatchObject({
      found: true,
      registration: {
        id: "personal-experimental-features",
        label: "Experimental Features",
      },
    });
    expect(
      resolveSettingsSection(settingsManifest, "personal", "advanced"),
    ).toMatchObject({ found: true, registration: { id: "personal-advanced" } });
  });

  it("renders the honest empty production registry", () => {
    const markup = renderToStaticMarkup(
      <ExperimentalFeaturesPanel data={data()} onToggle={() => undefined} />,
    );

    expect(markup).toContain("Experimental Features");
    expect(markup).toContain(
      "No experimental features are available in this build.",
    );
    expect(markup).toContain("owner and lifecycle plan");
    expect(markup).not.toContain("Fixture capability preview");
  });

  it("renders registry metadata, new-Thread semantics, lifecycle plans, and toggle", () => {
    const markup = renderToStaticMarkup(
      <ExperimentalFeaturesPanel
        data={data({ flags: [fixtureFlag] })}
        onToggle={() => undefined}
      />,
    );

    expect(markup).toContain("Fixture capability preview");
    expect(markup).toContain("experimental");
    expect(markup).toContain("dx/settings");
    expect(markup).toContain("medium risk");
    expect(markup).toContain("Personal scope");
    expect(markup).toContain("Review 2026-12-01");
    expect(markup).toContain("Applies only to new Threads");
    expect(markup).toContain("Migration, graduation, and removal plan");
    expect(markup).toContain('aria-label="Disable Fixture capability preview"');
    expect(markup).toContain('aria-pressed="true"');
  });

  it("renders a recoverable error without implying preferences changed", () => {
    const markup = renderToStaticMarkup(
      <ExperimentalFeaturesErrorState
        error="Experimental features could not be loaded."
        onRetry={() => undefined}
      />,
    );
    expect(markup).toContain('role="alert"');
    expect(markup).toContain("Experimental features could not be loaded.");
    expect(markup).toContain("saved preferences have not been changed");
    expect(markup).toContain("Try again");
  });
});
