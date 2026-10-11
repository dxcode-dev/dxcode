import {
  Principal,
  SettingsScopeForbidden,
  SettingsWorkspaceMembership,
  UserId,
  WorkspaceRepository,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsService } from "./service.js";

const rowan = Schema.decodeUnknownSync(Principal)({
  userId: Schema.decodeUnknownSync(UserId)("settings-rowan"),
  credentialScopes: ["personal", "workspace"],
});
const workspace = Schema.decodeUnknownSync(SettingsWorkspaceMembership)({
  workspace: {
    id: "workspace-id",
    displayName: "DX Team",
    shortName: "dx-team",
    lifecycleState: "active",
    revision: 0,
  },
  userId: rowan.userId,
  role: "owner",
});

const layer = SettingsService.layer.pipe(
  Layer.provide(
    Layer.succeed(
      WorkspaceRepository,
      WorkspaceRepository.of({
        findByUser: (userId) =>
          Effect.succeed(
            userId === rowan.userId ? Option.some(workspace) : Option.none(),
          ),
        createOwnedByUser: () => Effect.die("not used"),
        updateProfile: () => Effect.die("not used"),
      }),
    ),
  ),
);

const run = <A, E>(effect: Effect.Effect<A, E, SettingsService>) =>
  Effect.runPromise(effect.pipe(Effect.provide(layer)));

describe("SettingsService", () => {
  it("keeps personal credentials out of workspace context", async () => {
    const personalCredential = Schema.decodeUnknownSync(Principal)({
      userId: rowan.userId,
      credentialScopes: ["personal"],
    });
    const operation = Effect.gen(function* () {
      const service = yield* SettingsService;
      const personal = yield* service.personal(personalCredential);
      const workspaceAttempt = yield* Effect.result(
        service.workspace(personalCredential, workspace.workspace.shortName),
      );
      return { personal, workspaceAttempt };
    });

    const result = await run(operation);
    expect(result.personal).toEqual({ activeScope: "personal" });
    expect(result.workspaceAttempt).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "SettingsScopeForbidden" },
    });
  });

  it("rejects credentials without personal settings access", async () => {
    const workspaceCredential = Schema.decodeUnknownSync(Principal)({
      userId: rowan.userId,
      credentialScopes: ["workspace"],
    });
    const operation = Effect.gen(function* () {
      const service = yield* SettingsService;
      return yield* service.personal(workspaceCredential);
    });

    await expect(run(operation)).rejects.toBeInstanceOf(SettingsScopeForbidden);
  });
});
