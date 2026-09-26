import {
  createExperimentalFeatureRegistry,
  type ExperimentalFeatureRegistry,
  productionExperimentalFeatureRegistry,
} from "@dx/domain";
import type { Bindings } from "../../http/types.js";

declare const __DX_CORE_DEV_FIXTURES__: boolean;

const common = {
  owner: {
    team: "dx/settings",
    issue: "https://github.com/ravindrabarthwal/dx/issues/48",
  },
  status: "experimental",
  defaultEnabled: false,
  allowedScope: "personal",
  reviewDate: "2026-12-01",
  lifecyclePlan: {
    migration:
      "Drop the fixture preference when the local fixture registry is disabled.",
    graduation:
      "Replace the fixture evaluator call with the corresponding standard test behavior.",
    removal:
      "Delete the fixture registration and discard its stale preference.",
  },
} as const;

export const experimentalFeatureDevFixtureRegistry =
  /* @__PURE__ */ createExperimentalFeatureRegistry({
    version: 1,
    features: [
      {
        ...common,
        id: "fixture-capability-preview",
        title: "Fixture capability preview",
        description:
          "Exercises server-side capability evaluation without enabling a production dx feature.",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: ["fixture-safe-mode-preview"],
        activation: "new-thread",
      },
      {
        ...common,
        id: "fixture-dependent-preview",
        title: "Fixture dependent preview",
        description:
          "Exercises a feature that requires the fixture capability preview first.",
        kind: "interface",
        risk: "low",
        prerequisites: ["fixture-capability-preview"],
        incompatibilities: [],
        activation: "restart",
      },
      {
        ...common,
        id: "fixture-safe-mode-preview",
        title: "Fixture safe-mode preview",
        description:
          "Exercises deterministic incompatibility handling for the local fixture only.",
        kind: "security",
        risk: "high",
        prerequisites: [],
        incompatibilities: ["fixture-capability-preview"],
        activation: "immediate",
      },
    ],
    migrations: [],
  });

export const experimentalFeatureRegistryFor = (
  bindings: Bindings,
): ExperimentalFeatureRegistry =>
  typeof __DX_CORE_DEV_FIXTURES__ !== "undefined" &&
  __DX_CORE_DEV_FIXTURES__ &&
  bindings.DX_ENV === "local" &&
  bindings.DX_EXPERIMENTAL_FEATURE_FIXTURE === "capability"
    ? experimentalFeatureDevFixtureRegistry
    : productionExperimentalFeatureRegistry;
