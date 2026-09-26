import {
  type ExperimentalFeatureId,
  type ExperimentalFeaturePreference,
  ExperimentalFeaturePreferenceInvalid,
  type ExperimentalFeaturePreferencesConflict,
  ExperimentalFeaturePreferencesRepository,
  type ExperimentalFeaturePreferencesRevision,
  type ExperimentalFeatureRegistration,
  type ExperimentalFeatureRegistry,
  normalizeExperimentalFeaturePreferences,
  type PersistenceUnavailable,
  type PersonalExperimentalFeaturePreferences,
  type Principal,
  type SettingsMembershipInvariantViolation,
  type SettingsScopeForbidden,
  validateExperimentalFeaturePreferences,
} from "@dx/domain";
import { Context, Effect, Layer, type Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";

export type ExperimentalFeatureDenialReason =
  | "prerequisite-disabled"
  | "incompatible-feature";

export interface ExperimentalFeatureViewItem {
  readonly registration: ExperimentalFeatureRegistration;
  readonly personalEnabled: boolean;
  readonly preferenceSource: "default" | "personal";
  readonly effectiveEnabled: boolean;
  readonly denialReason?: ExperimentalFeatureDenialReason;
  readonly blockedBy: ReadonlyArray<ExperimentalFeatureId>;
}

export interface PersonalExperimentalFeaturesView {
  readonly registryVersion: number;
  readonly revision: ExperimentalFeaturePreferencesRevision;
  readonly flags: ReadonlyArray<ExperimentalFeatureViewItem>;
}

export interface ExperimentalFeatureCapabilityConstraints {
  readonly authorizationAllowed: boolean;
  readonly retentionAllowed: boolean;
  readonly securityPolicyAllowed: boolean;
}

export interface ExperimentalFeatureCapabilityDecision {
  readonly enabled: boolean;
  readonly reason?:
    | "not-registered"
    | "personal-preference"
    | "prerequisite-disabled"
    | "incompatible-feature"
    | "authorization-denied"
    | "retention-denied"
    | "security-policy-denied";
}

type ReadError =
  | Schema.SchemaError
  | PersistenceUnavailable
  | SettingsMembershipInvariantViolation
  | SettingsScopeForbidden;

interface ExperimentalFeaturesServiceShape {
  readonly getPersonal: (
    principal: Principal,
    registry: ExperimentalFeatureRegistry,
  ) => Effect.Effect<PersonalExperimentalFeaturesView, ReadError>;
  readonly updatePersonal: (
    principal: Principal,
    registry: ExperimentalFeatureRegistry,
    input: {
      readonly featureId: ExperimentalFeatureId;
      readonly enabled: boolean;
      readonly expectedRevision: ExperimentalFeaturePreferencesRevision;
    },
    requestId: string,
  ) => Effect.Effect<
    PersonalExperimentalFeaturesView,
    | ReadError
    | ExperimentalFeaturePreferenceInvalid
    | ExperimentalFeaturePreferencesConflict
  >;
  readonly evaluateCapability: (
    principal: Principal,
    registry: ExperimentalFeatureRegistry,
    featureId: ExperimentalFeatureId,
    constraints: ExperimentalFeatureCapabilityConstraints,
  ) => Effect.Effect<ExperimentalFeatureCapabilityDecision, ReadError>;
}

const requestedState = (
  registry: ExperimentalFeatureRegistry,
  preferences: ReadonlyArray<ExperimentalFeaturePreference>,
) => {
  const overrides = new Map(
    preferences.map(({ id, enabled }) => [id, enabled]),
  );
  return new Map(
    registry.features.map((feature) => [
      feature.id,
      overrides.get(feature.id) ?? feature.defaultEnabled,
    ]),
  );
};

const preferenceItems = (
  registry: ExperimentalFeatureRegistry,
  preferences: ReadonlyArray<ExperimentalFeaturePreference>,
): ReadonlyArray<ExperimentalFeatureViewItem> => {
  const requested = requestedState(registry, preferences);
  const registrations = new Map(
    registry.features.map((feature) => [feature.id, feature]),
  );
  const effective = new Map<ExperimentalFeatureId, boolean>();
  const resolve = (feature: ExperimentalFeatureRegistration): boolean => {
    const cached = effective.get(feature.id);
    if (cached !== undefined) return cached;
    const result =
      requested.get(feature.id) === true &&
      feature.prerequisites.every((id) => {
        const prerequisite = registrations.get(id);
        return prerequisite !== undefined && resolve(prerequisite);
      }) &&
      feature.incompatibilities.every((id) => requested.get(id) !== true);
    effective.set(feature.id, result);
    return result;
  };
  const overrides = new Set(preferences.map(({ id }) => id));
  return registry.features.map((registration) => {
    const personalEnabled = requested.get(registration.id) === true;
    const unavailablePrerequisites = personalEnabled
      ? registration.prerequisites.filter((id) => {
          const prerequisite = registrations.get(id);
          return prerequisite === undefined || !resolve(prerequisite);
        })
      : [];
    const incompatibilities = personalEnabled
      ? registration.incompatibilities.filter(
          (id) => requested.get(id) === true,
        )
      : [];
    const denialReason =
      unavailablePrerequisites.length > 0
        ? ("prerequisite-disabled" as const)
        : incompatibilities.length > 0
          ? ("incompatible-feature" as const)
          : undefined;
    return {
      registration,
      personalEnabled,
      preferenceSource: overrides.has(registration.id)
        ? ("personal" as const)
        : ("default" as const),
      effectiveEnabled: resolve(registration),
      ...(denialReason === undefined ? {} : { denialReason }),
      blockedBy: [...unavailablePrerequisites, ...incompatibilities],
    };
  });
};

export class ExperimentalFeaturesService extends Context.Service<
  ExperimentalFeaturesService,
  ExperimentalFeaturesServiceShape
>()("@dx/core/settings/experimental-features/ExperimentalFeaturesService") {
  static readonly layer = Layer.effect(
    ExperimentalFeaturesService,
    Effect.gen(function* () {
      const repository = yield* ExperimentalFeaturePreferencesRepository;
      const settings = yield* SettingsService;
      const audit = yield* SettingsAudit;

      const clean = (
        registry: ExperimentalFeatureRegistry,
        current: PersonalExperimentalFeaturePreferences,
        retry: boolean,
      ): Effect.Effect<PersonalExperimentalFeaturePreferences, ReadError> => {
        const normalized = normalizeExperimentalFeaturePreferences(
          registry,
          current.preferences,
        );
        if (!normalized.changed) return Effect.succeed(current);
        return repository
          .put(current.userId, normalized.preferences, current.revision)
          .pipe(
            Effect.catchTag("ExperimentalFeaturePreferencesConflict", () =>
              retry
                ? repository
                    .get(current.userId)
                    .pipe(
                      Effect.flatMap((latest) =>
                        clean(registry, latest, false),
                      ),
                    )
                : repository.get(current.userId),
            ),
          );
      };

      const current = Effect.fn("ExperimentalFeaturesService.current")(
        function* (
          principal: Principal,
          registry: ExperimentalFeatureRegistry,
        ) {
          yield* settings.personal(principal);
          return yield* clean(
            registry,
            yield* repository.get(principal.userId),
            true,
          );
        },
      );

      const view = (
        registry: ExperimentalFeatureRegistry,
        stored: PersonalExperimentalFeaturePreferences,
      ): PersonalExperimentalFeaturesView => ({
        registryVersion: registry.version,
        revision: stored.revision,
        flags: preferenceItems(registry, stored.preferences),
      });

      const getPersonal = Effect.fn("ExperimentalFeaturesService.getPersonal")(
        function* (
          principal: Principal,
          registry: ExperimentalFeatureRegistry,
        ) {
          return view(registry, yield* current(principal, registry));
        },
      );

      return ExperimentalFeaturesService.of({
        getPersonal,
        updatePersonal: Effect.fn("ExperimentalFeaturesService.updatePersonal")(
          function* (principal, registry, input, requestId) {
            const stored = yield* current(principal, registry);
            const registration = registry.features.find(
              ({ id }) => id === input.featureId,
            );
            if (registration === undefined) {
              return yield* new ExperimentalFeaturePreferenceInvalid({
                featureId: input.featureId,
                reason: "unknown-feature",
              });
            }
            const nextById = new Map(
              stored.preferences.map(({ id, enabled }) => [id, enabled]),
            );
            if (input.enabled === registration.defaultEnabled) {
              nextById.delete(input.featureId);
            } else {
              nextById.set(input.featureId, input.enabled);
            }
            const next = registry.features.flatMap(({ id }) => {
              const enabled = nextById.get(id);
              return enabled === undefined ? [] : [{ id, enabled }];
            });
            try {
              validateExperimentalFeaturePreferences(registry, next);
            } catch (cause) {
              if (cause instanceof ExperimentalFeaturePreferenceInvalid) {
                return yield* cause;
              }
              throw cause;
            }
            const saved = yield* repository
              .put(principal.userId, next, input.expectedRevision)
              .pipe(
                Effect.tap(() =>
                  audit.record({
                    action: "experimental_features.personal.update",
                    scope: "personal",
                    outcome: "success",
                    requestId,
                    userId: principal.userId,
                    experimentalFeatureId: input.featureId,
                  }),
                ),
                Effect.tapError(() =>
                  audit.record({
                    action: "experimental_features.personal.update",
                    scope: "personal",
                    outcome: "rejected",
                    requestId,
                    userId: principal.userId,
                    experimentalFeatureId: input.featureId,
                  }),
                ),
              );
            return view(registry, saved);
          },
        ),
        evaluateCapability: Effect.fn(
          "ExperimentalFeaturesService.evaluateCapability",
        )(function* (principal, registry, featureId, constraints) {
          yield* settings.personal(principal);
          if (!constraints.authorizationAllowed) {
            return { enabled: false, reason: "authorization-denied" };
          }
          if (!constraints.retentionAllowed) {
            return { enabled: false, reason: "retention-denied" };
          }
          if (!constraints.securityPolicyAllowed) {
            return { enabled: false, reason: "security-policy-denied" };
          }
          const feature = registry.features.find(({ id }) => id === featureId);
          if (feature === undefined) {
            return { enabled: false, reason: "not-registered" };
          }
          const item = (yield* getPersonal(principal, registry)).flags.find(
            ({ registration }) => registration.id === featureId,
          );
          if (item?.effectiveEnabled === true) return { enabled: true };
          return {
            enabled: false,
            reason:
              item?.denialReason ??
              (item?.personalEnabled === false
                ? "personal-preference"
                : "not-registered"),
          };
        }),
      });
    }),
  );
}
