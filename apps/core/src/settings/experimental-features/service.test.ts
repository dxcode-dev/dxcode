import {
  type ExperimentalFeatureId,
  ExperimentalFeaturePreferenceInvalid,
  ExperimentalFeaturePreferencesConflict,
  ExperimentalFeaturePreferencesRepository,
  ExperimentalFeaturePreferencesRevision,
  PersonalExperimentalFeaturePreferences,
  Principal,
  productionExperimentalFeatureRegistry,
  SettingsScopeForbidden,
  WorkspaceMembership,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit } from "../audit.js";
import { SettingsService } from "../service.js";
import { experimentalFeatureDevFixtureRegistry } from "./registry.js";
import { ExperimentalFeaturesService } from "./service.js";

const principal = Schema.decodeUnknownSync(Principal)({
  userId: "experimental-user",
  credentialScopes: ["personal", "workspace"],
});
const membership = Schema.decodeUnknownSync(WorkspaceMembership)({
  workspace: {
    id: "experimental-workspace",
    displayName: "Experimental Team",
    shortName: "experimental-team",
    lifecycleState: "active",
    revision: 0,
  },
  userId: principal.userId,
  role: "member",
});
const capability = experimentalFeatureDevFixtureRegistry.features[0];
const dependent = experimentalFeatureDevFixtureRegistry.features[1];
const alternative = experimentalFeatureDevFixtureRegistry.features[2];
if (
  capability === undefined ||
  dependent === undefined ||
  alternative === undefined
) {
  throw new Error("Experimental feature fixture registry is incomplete.");
}
const revision = (value: number) =>
  Schema.decodeUnknownSync(ExperimentalFeaturePreferencesRevision)(value);

const layerFor = (input?: { readonly workspace?: boolean }) => {
  let preferences = Schema.decodeUnknownSync(
    PersonalExperimentalFeaturePreferences,
  )({
    userId: principal.userId,
    preferences: [],
    revision: 0,
    updatedAt: null,
  });
  const workspaces = Layer.succeed(
    WorkspaceRepository,
    WorkspaceRepository.of({
      findByUser: () =>
        Effect.succeed(
          input?.workspace ? Option.some(membership) : Option.none(),
        ),
      createOwnedByUser: () => Effect.die("not used"),
      updateProfile: () => Effect.die("not used"),
    }),
  );
  const repository = Layer.succeed(
    ExperimentalFeaturePreferencesRepository,
    ExperimentalFeaturePreferencesRepository.of({
      get: () => Effect.succeed(preferences),
      put: (_userId, next, expectedRevision) => {
        if (preferences.revision !== expectedRevision) {
          return Effect.fail(
            new ExperimentalFeaturePreferencesConflict({
              currentRevision: preferences.revision,
            }),
          );
        }
        preferences = Schema.decodeUnknownSync(
          PersonalExperimentalFeaturePreferences,
        )({
          userId: principal.userId,
          preferences: next,
          revision: preferences.revision + 1,
          updatedAt: "2026-08-23T00:00:00.000Z",
        });
        return Effect.succeed(preferences);
      },
    }),
  );
  const settings = SettingsService.layer.pipe(Layer.provide(workspaces));
  return ExperimentalFeaturesService.layer.pipe(
    Layer.provide(Layer.mergeAll(repository, settings, SettingsAudit.layer)),
  );
};

const run = <Value, Error>(
  layer: ReturnType<typeof layerFor>,
  effect: Effect.Effect<Value, Error, ExperimentalFeaturesService>,
) => Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("ExperimentalFeaturesService", () => {
  it("ships an honest empty production registry and fixture defaults off", async () => {
    const layer = layerFor();
    const production = await run(
      layer,
      Effect.gen(function* () {
        const service = yield* ExperimentalFeaturesService;
        return yield* service.getPersonal(
          principal,
          productionExperimentalFeatureRegistry,
        );
      }),
    );
    const fixture = await run(
      layer,
      Effect.gen(function* () {
        const service = yield* ExperimentalFeaturesService;
        return yield* service.getPersonal(
          principal,
          experimentalFeatureDevFixtureRegistry,
        );
      }),
    );

    expect(production.flags).toEqual([]);
    expect(fixture.flags).toHaveLength(3);
    expect(
      fixture.flags.every(({ effectiveEnabled }) => !effectiveEnabled),
    ).toBe(true);
  });

  it("rejects missing prerequisites and enabled incompatibilities", async () => {
    const layer = layerFor();
    const update = (
      featureId: ExperimentalFeatureId,
      expectedRevision: number,
    ) =>
      run(
        layer,
        Effect.gen(function* () {
          const service = yield* ExperimentalFeaturesService;
          return yield* service.updatePersonal(
            principal,
            experimentalFeatureDevFixtureRegistry,
            {
              featureId,
              enabled: true,
              expectedRevision: revision(expectedRevision),
            },
            "request-invalid-combination",
          );
        }),
      );

    await expect(update(dependent.id, 0)).rejects.toBeInstanceOf(
      ExperimentalFeaturePreferenceInvalid,
    );
    await expect(update(capability.id, 0)).resolves.toMatchObject({
      revision: 1,
    });
    await expect(update(alternative.id, 1)).rejects.toBeInstanceOf(
      ExperimentalFeaturePreferenceInvalid,
    );
  });

  it("keeps capability evaluation additive to authorization, retention, and security policy", async () => {
    const layer = layerFor();
    await run(
      layer,
      Effect.gen(function* () {
        const service = yield* ExperimentalFeaturesService;
        yield* service.updatePersonal(
          principal,
          experimentalFeatureDevFixtureRegistry,
          {
            featureId: capability.id,
            enabled: true,
            expectedRevision: revision(0),
          },
          "request-enable",
        );
      }),
    );
    const evaluate = (constraints: {
      authorizationAllowed: boolean;
      retentionAllowed: boolean;
      securityPolicyAllowed: boolean;
    }) =>
      run(
        layer,
        Effect.gen(function* () {
          const service = yield* ExperimentalFeaturesService;
          return yield* service.evaluateCapability(
            principal,
            experimentalFeatureDevFixtureRegistry,
            capability.id,
            constraints,
          );
        }),
      );

    await expect(
      evaluate({
        authorizationAllowed: false,
        retentionAllowed: true,
        securityPolicyAllowed: true,
      }),
    ).resolves.toEqual({ enabled: false, reason: "authorization-denied" });
    await expect(
      evaluate({
        authorizationAllowed: true,
        retentionAllowed: false,
        securityPolicyAllowed: true,
      }),
    ).resolves.toEqual({ enabled: false, reason: "retention-denied" });
    await expect(
      evaluate({
        authorizationAllowed: true,
        retentionAllowed: true,
        securityPolicyAllowed: false,
      }),
    ).resolves.toEqual({ enabled: false, reason: "security-policy-denied" });
    await expect(
      evaluate({
        authorizationAllowed: true,
        retentionAllowed: true,
        securityPolicyAllowed: true,
      }),
    ).resolves.toEqual({ enabled: true });
  });

  it("cannot use a feature preference to acquire personal settings authorization", async () => {
    const unauthorized = Schema.decodeUnknownSync(Principal)({
      userId: principal.userId,
      credentialScopes: ["workspace"],
    });
    await expect(
      run(
        layerFor(),
        Effect.gen(function* () {
          const service = yield* ExperimentalFeaturesService;
          return yield* service.evaluateCapability(
            unauthorized,
            experimentalFeatureDevFixtureRegistry,
            capability.id,
            {
              authorizationAllowed: true,
              retentionAllowed: true,
              securityPolicyAllowed: true,
            },
          );
        }),
      ),
    ).rejects.toBeInstanceOf(SettingsScopeForbidden);
  });
});
