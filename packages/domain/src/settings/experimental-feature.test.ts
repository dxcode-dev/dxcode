import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  createExperimentalFeatureRegistry,
  ExperimentalFeaturePreference,
  ExperimentalFeaturePreferenceInvalid,
  normalizeExperimentalFeaturePreferences,
  validateExperimentalFeaturePreferences,
} from "./experimental-feature.js";

const registration = (
  id: string,
  input: {
    readonly prerequisites?: ReadonlyArray<string>;
    readonly incompatibilities?: ReadonlyArray<string>;
    readonly defaultEnabled?: boolean;
  } = {},
) => ({
  id,
  title: id,
  description: `Fixture description for ${id}.`,
  owner: {
    team: "dx/settings",
    issue: "https://github.com/ravindrabarthwal/dx/issues/48",
  },
  status: "experimental",
  defaultEnabled: input.defaultEnabled ?? false,
  allowedScope: "personal",
  kind: "capability",
  risk: "medium",
  prerequisites: input.prerequisites ?? [],
  incompatibilities: input.incompatibilities ?? [],
  activation: "new-thread",
  reviewDate: "2026-12-01",
  lifecyclePlan: {
    migration: "Remove stored preference after compatibility review.",
    graduation: "Delete the evaluator call and make the capability standard.",
    removal: "Delete the capability and safely discard its preference.",
  },
});

const registry = createExperimentalFeatureRegistry({
  version: 4,
  features: [
    registration("fixture-base", {
      incompatibilities: ["fixture-alternative"],
    }),
    registration("fixture-dependent", {
      prerequisites: ["fixture-base"],
    }),
    registration("fixture-alternative", {
      incompatibilities: ["fixture-base"],
    }),
  ],
  migrations: [
    { kind: "rename", from: "fixture-legacy", to: "fixture-base" },
    { kind: "retire", id: "fixture-removed", outcome: "removed" },
    { kind: "retire", id: "fixture-graduated", outcome: "graduated" },
  ],
});

const preferences = (input: ReadonlyArray<{ id: string; enabled: boolean }>) =>
  Schema.decodeUnknownSync(Schema.Array(ExperimentalFeaturePreference))(input);

describe("experimental feature registry", () => {
  it("validates unique IDs, references, symmetric incompatibilities, and cycles", () => {
    expect(() =>
      createExperimentalFeatureRegistry({
        version: 1,
        features: [registration("duplicate"), registration("duplicate")],
        migrations: [],
      }),
    ).toThrow("Duplicate experimental feature ID");
    expect(() =>
      createExperimentalFeatureRegistry({
        version: 1,
        features: [
          registration("left", { incompatibilities: ["right"] }),
          registration("right"),
        ],
        migrations: [],
      }),
    ).toThrow("must be registered symmetrically");
    expect(() =>
      createExperimentalFeatureRegistry({
        version: 1,
        features: [
          registration("first", { prerequisites: ["second"] }),
          registration("second", { prerequisites: ["first"] }),
        ],
        migrations: [],
      }),
    ).toThrow("prerequisite cycle");
  });

  it("migrates renamed preferences and cleans unknown, removed, and graduated IDs", () => {
    const result = normalizeExperimentalFeaturePreferences(
      registry,
      preferences([
        { id: "fixture-legacy", enabled: true },
        { id: "fixture-removed", enabled: true },
        { id: "fixture-graduated", enabled: false },
        { id: "fixture-unknown", enabled: true },
      ]),
    );

    expect(result).toEqual({
      preferences: [{ id: "fixture-base", enabled: true }],
      changed: true,
    });
  });

  it("uses a current preference over its stale alias deterministically", () => {
    expect(
      normalizeExperimentalFeaturePreferences(
        registry,
        preferences([
          { id: "fixture-base", enabled: false },
          { id: "fixture-legacy", enabled: true },
        ]),
      ).preferences,
    ).toEqual([]);
  });

  it("fails preference combinations with disabled prerequisites or incompatibilities", () => {
    expect(() =>
      validateExperimentalFeaturePreferences(
        registry,
        preferences([{ id: "fixture-dependent", enabled: true }]),
      ),
    ).toThrow(ExperimentalFeaturePreferenceInvalid);
    expect(() =>
      validateExperimentalFeaturePreferences(
        registry,
        preferences([
          { id: "fixture-base", enabled: true },
          { id: "fixture-alternative", enabled: true },
        ]),
      ),
    ).toThrow(ExperimentalFeaturePreferenceInvalid);
  });

  it("makes rollback to a build without a new ID deterministically fail closed", () => {
    const rollbackRegistry = createExperimentalFeatureRegistry({
      version: 3,
      features: [],
      migrations: [],
    });
    expect(
      normalizeExperimentalFeaturePreferences(
        rollbackRegistry,
        preferences([{ id: "fixture-base", enabled: true }]),
      ),
    ).toEqual({ preferences: [], changed: true });
  });
});
