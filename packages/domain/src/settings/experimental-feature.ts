import { Schema } from "effect";

export const ExperimentalFeatureId = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(80),
  Schema.isPattern(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
).pipe(Schema.brand("@dx/ExperimentalFeatureId"));

export type ExperimentalFeatureId = typeof ExperimentalFeatureId.Type;

export const ExperimentalFeatureLifecycleStatus = Schema.Literals([
  "experimental",
  "graduating",
]);

export const ExperimentalFeatureRisk = Schema.Literals([
  "low",
  "medium",
  "high",
]);

export const ExperimentalFeatureKind = Schema.Literals([
  "interface",
  "capability",
  "security",
]);

export const ExperimentalFeatureActivation = Schema.Literals([
  "immediate",
  "restart",
  "new-thread",
]);

const LifecyclePlanText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(500),
);

export const ExperimentalFeatureRegistration = Schema.Struct({
  id: ExperimentalFeatureId,
  title: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  description: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(500),
  ),
  owner: Schema.Struct({
    team: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
    /**
     * The public lifecycle issue, when there is one. A feature tracked only
     * in a private repository omits it: its name must not ship.
     */
    issue: Schema.optional(
      Schema.String.check(
        Schema.isPattern(/^https:\/\/github\.com\/[^/]+\/[^/]+\/issues\/\d+$/),
      ),
    ),
  }),
  status: ExperimentalFeatureLifecycleStatus,
  defaultEnabled: Schema.Boolean,
  allowedScope: Schema.Literal("personal"),
  kind: ExperimentalFeatureKind,
  risk: ExperimentalFeatureRisk,
  prerequisites: Schema.Array(ExperimentalFeatureId),
  incompatibilities: Schema.Array(ExperimentalFeatureId),
  activation: ExperimentalFeatureActivation,
  reviewDate: Schema.String.check(
    Schema.isPattern(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/),
  ),
  lifecyclePlan: Schema.Struct({
    migration: LifecyclePlanText,
    graduation: LifecyclePlanText,
    removal: LifecyclePlanText,
  }),
});

export type ExperimentalFeatureRegistration =
  typeof ExperimentalFeatureRegistration.Type;

export const ExperimentalFeatureMigration = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("rename"),
    from: ExperimentalFeatureId,
    to: ExperimentalFeatureId,
  }),
  Schema.Struct({
    kind: Schema.Literal("retire"),
    id: ExperimentalFeatureId,
    outcome: Schema.Literals(["removed", "graduated"]),
  }),
]);

export type ExperimentalFeatureMigration =
  typeof ExperimentalFeatureMigration.Type;

export const ExperimentalFeatureRegistry = Schema.Struct({
  version: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  features: Schema.Array(ExperimentalFeatureRegistration),
  migrations: Schema.Array(ExperimentalFeatureMigration),
});

export type ExperimentalFeatureRegistry =
  typeof ExperimentalFeatureRegistry.Type;

export const ExperimentalFeaturePreference = Schema.Struct({
  id: ExperimentalFeatureId,
  enabled: Schema.Boolean,
});

export type ExperimentalFeaturePreference =
  typeof ExperimentalFeaturePreference.Type;

export const ExperimentalFeaturePreferenceInvalidReason = Schema.Literals([
  "unknown-feature",
  "prerequisite-disabled",
  "incompatible-feature",
]);

export class ExperimentalFeaturePreferenceInvalid extends Schema.TaggedError<ExperimentalFeaturePreferenceInvalid>()(
  "ExperimentalFeaturePreferenceInvalid",
  {
    featureId: ExperimentalFeatureId,
    reason: ExperimentalFeaturePreferenceInvalidReason,
    relatedFeatureId: Schema.optional(ExperimentalFeatureId),
  },
) {}

export interface NormalizedExperimentalFeaturePreferences {
  readonly preferences: ReadonlyArray<ExperimentalFeaturePreference>;
  readonly changed: boolean;
}

const duplicate = (values: ReadonlyArray<string>) => {
  const seen = new Set<string>();
  return values.find((value) => {
    if (seen.has(value)) return true;
    seen.add(value);
    return false;
  });
};

const validateRegistryRelationships = (
  registry: ExperimentalFeatureRegistry,
) => {
  const ids = registry.features.map(({ id }) => id);
  const duplicateId = duplicate(ids);
  if (duplicateId !== undefined) {
    throw new Error(`Duplicate experimental feature ID: ${duplicateId}`);
  }
  const byId = new Map(
    registry.features.map((feature) => [feature.id, feature]),
  );
  for (const feature of registry.features) {
    const duplicatePrerequisite = duplicate(feature.prerequisites);
    if (duplicatePrerequisite !== undefined) {
      throw new Error(
        `Duplicate prerequisite ${duplicatePrerequisite} for ${feature.id}`,
      );
    }
    const duplicateIncompatibility = duplicate(feature.incompatibilities);
    if (duplicateIncompatibility !== undefined) {
      throw new Error(
        `Duplicate incompatibility ${duplicateIncompatibility} for ${feature.id}`,
      );
    }
    for (const prerequisite of feature.prerequisites) {
      if (prerequisite === feature.id || !byId.has(prerequisite)) {
        throw new Error(
          `Invalid prerequisite ${prerequisite} for ${feature.id}`,
        );
      }
    }
    for (const incompatible of feature.incompatibilities) {
      const counterpart = byId.get(incompatible);
      if (
        incompatible === feature.id ||
        counterpart === undefined ||
        !counterpart.incompatibilities.includes(feature.id)
      ) {
        throw new Error(
          `Incompatibility ${feature.id} / ${incompatible} must be registered symmetrically`,
        );
      }
    }
  }

  const visiting = new Set<ExperimentalFeatureId>();
  const visited = new Set<ExperimentalFeatureId>();
  const visit = (id: ExperimentalFeatureId) => {
    if (visiting.has(id)) {
      throw new Error(`Experimental feature prerequisite cycle at ${id}`);
    }
    if (visited.has(id)) return;
    visiting.add(id);
    for (const prerequisite of byId.get(id)?.prerequisites ?? []) {
      visit(prerequisite);
    }
    visiting.delete(id);
    visited.add(id);
  };
  for (const id of ids) visit(id);

  for (const feature of registry.features) {
    if (
      feature.defaultEnabled &&
      feature.prerequisites.some(
        (prerequisite) => !byId.get(prerequisite)?.defaultEnabled,
      )
    ) {
      throw new Error(
        `Default-enabled feature ${feature.id} has a disabled prerequisite`,
      );
    }
    if (
      feature.defaultEnabled &&
      feature.incompatibilities.some(
        (incompatible) => byId.get(incompatible)?.defaultEnabled,
      )
    ) {
      throw new Error(
        `Default-enabled feature ${feature.id} has a default-enabled incompatibility`,
      );
    }
  }

  const migrationSources = registry.migrations.map((migration) =>
    migration.kind === "rename" ? migration.from : migration.id,
  );
  const duplicateMigration = duplicate(migrationSources);
  if (duplicateMigration !== undefined) {
    throw new Error(
      `Duplicate experimental feature migration source: ${duplicateMigration}`,
    );
  }
  for (const migration of registry.migrations) {
    const source = migration.kind === "rename" ? migration.from : migration.id;
    if (byId.has(source)) {
      throw new Error(`Migration source remains registered: ${source}`);
    }
    if (migration.kind === "rename" && !byId.has(migration.to)) {
      throw new Error(`Migration target is not registered: ${migration.to}`);
    }
  }
};

export const createExperimentalFeatureRegistry = (
  input: unknown,
): ExperimentalFeatureRegistry => {
  const registry = Schema.decodeUnknownSync(ExperimentalFeatureRegistry)(input);
  validateRegistryRelationships(registry);
  return registry;
};

export const productionExperimentalFeatureRegistry =
  createExperimentalFeatureRegistry({
    version: 1,
    features: [
      {
        id: "artifact-notify-agent",
        title: "Notify agent from artifacts",
        description:
          "Saving, ticking, or changing an artifact no longer wakes the agent. Notify agent in the artifact toolbar wakes it once with what changed, and a comment that mentions @dx wakes it right away.",
        // Tracked in #1765.
        owner: { team: "dx/artifacts" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "interface",
        risk: "low",
        prerequisites: [],
        incompatibilities: [],
        activation: "immediate",
        reviewDate: "2027-02-15",
        lifecyclePlan: {
          migration:
            "Nothing is stored for the flag; turning it off brings back waking on ticks and answers, and hides Notify agent.",
          graduation:
            "Drop the flag check from artifact saves, comments, the notify route, and the toolbar.",
          removal:
            "Delete the notify route, the toolbar button, and the flag checks; ticks and answers wake as before.",
        },
      },
      {
        id: "composer-quick-actions",
        title: "Composer quick actions",
        description:
          "When the agent ends a turn, a small Workers AI model writes the replies you might send next, and Cloudflare's Clef Flash model picks which quick actions to show above the composer, and in what order: Snooze Until I'm Needed and those replies.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/threads" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "interface",
        risk: "low",
        prerequisites: [],
        incompatibilities: [],
        activation: "immediate",
        reviewDate: "2027-01-15",
        lifecyclePlan: {
          migration:
            "Each Thread keeps its latest pick in thread_quick_actions; turning the flag off hides the row at once and stops new picks.",
          graduation:
            "Drop the flag check from the turn-end hook, the quick-actions route, and the Thread page.",
          removal:
            "Delete the turn-end hook, the quick-actions route, the composer row, and drop thread_quick_actions.",
        },
      },
      {
        id: "claude-plan-auto-pick",
        title: "Pick my Claude plan automatically",
        description:
          "A new Claude Code Thread that names no plan gets one of your Claude Pro/Max plans picked by their limits and running Threads. Off, you pick the plan.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/model-routing" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: [],
        activation: "new-thread",
        reviewDate: "2027-01-15",
        lifecyclePlan: {
          migration: "Nothing is stored; bound Threads keep their plan.",
          graduation: "Drop the flag checks.",
          removal: "Delete the automatic pick and the composer's Auto.",
        },
      },
      {
        id: "feedback-widget",
        title: "Feedback Widget",
        description:
          "Adds Feedback Widget to Project Settings: a script for your website that lets you click any element, write what to change, and send it to a new Thread in the Project. You need it on to set up the widget and to send from it.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/projects" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: [],
        activation: "immediate",
        reviewDate: "2027-02-15",
        lifecyclePlan: {
          migration:
            "Widgets, origins, and grants stay in D1; turning the flag off hides the settings tab and refuses setup and sending.",
          graduation:
            "Drop the flag checks from the settings tab, the settings routes, and the send route.",
          removal:
            "Turn every widget off, drop its tables, and delete the public widget routes and the settings tab.",
        },
      },
      {
        id: "orb-provider-freestyle",
        title: "Freestyle Orbs",
        description:
          "Beta: offers Freestyle in Orb Providers, the New Thread Orb picker, and Project Defaults, so you can connect it and start Threads on it. It doesn't offer every workspace feature yet; its Orbs have no Desktop. Off, Threads already on it keep running.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/execution" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: [],
        activation: "new-thread",
        reviewDate: "2027-01-15",
        lifecyclePlan: {
          migration:
            "Nothing is stored for the flag; connections stay saved, and Threads pinned to the provider keep running when it is off.",
          graduation:
            "Once the provider offers every workspace feature (#1924), remove betaFeature from its descriptor and retire this flag as graduated.",
          removal:
            "Retire the flag as removed and drop the provider's descriptor, connector, and sizes.",
        },
      },
      {
        id: "orb-provider-docker",
        title: "Docker Cloud Sandboxes Orbs",
        description:
          "Beta: offers Docker Cloud Sandboxes in Orb Providers, the New Thread Orb picker, and Project Defaults, so you can connect it and start Threads on it. dx hasn't yet checked every workspace feature on it, such as the Desktop. Off, Threads already on it keep running.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/execution" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: [],
        activation: "new-thread",
        reviewDate: "2027-01-15",
        lifecyclePlan: {
          migration:
            "Nothing is stored for the flag; connections stay saved, and Threads pinned to the provider keep running when it is off.",
          graduation:
            "Once the provider offers every workspace feature (#1924), remove betaFeature from its descriptor and retire this flag as graduated.",
          removal:
            "Retire the flag as removed and drop the provider's descriptor, connector, and sizes.",
        },
      },
      {
        id: "orb-provider-boat",
        title: "Boat Orbs",
        description:
          "Beta: offers Boat in Orb Providers, the New Thread Orb picker, and Project Defaults, so you can connect it and start Threads on it. It doesn't offer every workspace feature yet; its Orbs have no Desktop. Off, Threads already on it keep running.",
        // Tracked in the private repository, so no public issue yet.
        owner: { team: "dx/execution" },
        status: "experimental",
        defaultEnabled: false,
        allowedScope: "personal",
        kind: "capability",
        risk: "medium",
        prerequisites: [],
        incompatibilities: [],
        activation: "new-thread",
        reviewDate: "2027-01-15",
        lifecyclePlan: {
          migration:
            "Nothing is stored for the flag; connections stay saved, and Threads pinned to the provider keep running when it is off.",
          graduation:
            "Once the provider offers every workspace feature (#1924), remove betaFeature from its descriptor and retire this flag as graduated.",
          removal:
            "Retire the flag as removed and drop the provider's descriptor, connector, and sizes.",
        },
      },
    ],
    migrations: [
      { kind: "retire", id: "needs-you-prioritize", outcome: "removed" },
      { kind: "retire", id: "artifact-asks", outcome: "removed" },
      { kind: "retire", id: "orb-restart", outcome: "removed" },
    ],
  });

export const normalizeExperimentalFeaturePreferences = (
  registry: ExperimentalFeatureRegistry,
  input: ReadonlyArray<ExperimentalFeaturePreference>,
): NormalizedExperimentalFeaturePreferences => {
  const registered = new Set(registry.features.map(({ id }) => id));
  const renamed = new Map(
    registry.migrations.flatMap((migration) =>
      migration.kind === "rename" ? [[migration.from, migration.to]] : [],
    ),
  );
  const direct = new Map<ExperimentalFeatureId, boolean>();
  const migrated = new Map<ExperimentalFeatureId, boolean>();
  for (const preference of input) {
    if (registered.has(preference.id)) {
      direct.set(preference.id, preference.enabled);
      continue;
    }
    const target = renamed.get(preference.id);
    if (target !== undefined && registered.has(target)) {
      migrated.set(target, preference.enabled);
    }
  }
  const preferences = registry.features.flatMap(({ id, defaultEnabled }) => {
    const enabled = direct.get(id) ?? migrated.get(id);
    return enabled === undefined || enabled === defaultEnabled
      ? []
      : [{ id, enabled }];
  });
  return {
    preferences,
    changed: JSON.stringify(preferences) !== JSON.stringify(input),
  };
};

export const validateExperimentalFeaturePreferences = (
  registry: ExperimentalFeatureRegistry,
  input: ReadonlyArray<ExperimentalFeaturePreference>,
): void => {
  const preferences = new Map(input.map(({ id, enabled }) => [id, enabled]));
  const byId = new Map(
    registry.features.map((feature) => [feature.id, feature]),
  );
  const enabled = (feature: ExperimentalFeatureRegistration) =>
    preferences.get(feature.id) ?? feature.defaultEnabled;
  for (const feature of registry.features) {
    if (!enabled(feature)) continue;
    const missing = feature.prerequisites.find((id) => {
      const prerequisite = byId.get(id);
      return prerequisite === undefined || !enabled(prerequisite);
    });
    if (missing !== undefined) {
      throw new ExperimentalFeaturePreferenceInvalid({
        featureId: feature.id,
        reason: "prerequisite-disabled",
        relatedFeatureId: missing,
      });
    }
    const incompatible = feature.incompatibilities.find((id) => {
      const candidate = byId.get(id);
      return candidate !== undefined && enabled(candidate);
    });
    if (incompatible !== undefined) {
      throw new ExperimentalFeaturePreferenceInvalid({
        featureId: feature.id,
        reason: "incompatible-feature",
        relatedFeatureId: incompatible,
      });
    }
  }
};
