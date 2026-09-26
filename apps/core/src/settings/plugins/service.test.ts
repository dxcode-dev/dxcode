import {
  EnvironmentVariableRepository,
  McpServerRepository,
  type PluginGrantedPermissions,
  PluginId,
  PluginIntegrityConflict,
  PluginNotFound,
  PluginPermissionInvalid,
  PluginRepository,
  type PluginTarget,
  type Principal,
  pluginPermissionsEmpty,
  StoredPlugin,
  StoredPluginVersion,
  UserId,
  type WorkspacePolicyAction,
  WorkspacePolicyDenied,
} from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { SettingsAudit } from "../audit.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { previewPluginImport } from "./import.js";
import { PluginService } from "./service.js";

const owner = Schema.decodeUnknownSync(UserId)("plugin-service-owner");
const target = { scope: "personal", id: owner } satisfies PluginTarget;
const pluginId = Schema.decodeUnknownSync(PluginId)(
  "plg_00000000-0000-4000-8000-000000000045",
);
const timestamp = "2026-08-23T00:00:00.000Z";

const bundle = (
  version: string,
  requested: {
    readonly secretNames?: ReadonlyArray<string>;
    readonly mcpServerIds?: ReadonlyArray<string>;
  } = {},
) => ({
  source: { type: "browser-files" as const, label: "Reviewed test bundle" },
  files: [
    {
      path: "plugin.json",
      kind: "file" as const,
      mediaType: "application/json",
      encoding: "utf-8" as const,
      content: JSON.stringify({
        schemaVersion: 1,
        name: "review-helper",
        displayName: "Review helper",
        description: "Review a bounded input.",
        version,
        entrypoint: "main.mjs",
        tools: [{ name: "summarize", description: "Summarize input." }],
        commands: [],
        lifecycle: [],
        uiSurfaces: [],
        permissions: {
          tools: ["summarize"],
          commands: [],
          lifecycle: [],
          uiSurfaces: [],
          networkDestinations: [],
          secretNames: requested.secretNames ?? [],
          filesystem: [],
          mcpServerIds: requested.mcpServerIds ?? [],
          agentCapabilities: [],
        },
      }),
    },
    {
      path: "main.mjs",
      kind: "file" as const,
      mediaType: "text/javascript",
      encoding: "utf-8" as const,
      content: `export const tools = { summarize: ({ input }) => input }; // ${version}`,
    },
  ],
});

const grantedTools = (): PluginGrantedPermissions => ({
  ...pluginPermissionsEmpty(),
  tools: ["summarize" as never],
});

const harness = async (
  options: {
    readonly grants?: PluginGrantedPermissions;
    readonly target?: PluginTarget;
    readonly evaluateForUser?: (
      userId: UserId,
      action: WorkspacePolicyAction,
    ) => Effect.Effect<void, WorkspacePolicyDenied>;
  } = {},
) => {
  let insertVersionCalls = 0;
  const firstBundle = bundle("1.0.0", {
    secretNames: options.grants?.secretReferences.map(({ name }) => name),
    mcpServerIds: options.grants?.mcpServerIds,
  });
  const firstPreview = await Effect.runPromise(
    previewPluginImport(firstBundle),
  );
  let plugin = Schema.decodeUnknownSync(StoredPlugin)({
    id: pluginId,
    target: options.target ?? target,
    name: firstPreview.manifest.name,
    enabled: true,
    activeVersion: "1.0.0",
    healthStatus: "healthy",
    createdAt: timestamp,
    updatedAt: timestamp,
  });
  const versions = new Map([
    [
      "1.0.0",
      Schema.decodeUnknownSync(StoredPluginVersion)({
        pluginId,
        version: "1.0.0",
        manifest: firstPreview.manifest,
        files: firstPreview.files,
        source: firstPreview.source,
        integrity: firstPreview.integrity,
        grants: options.grants ?? grantedTools(),
        trusted: true,
        trustedAt: timestamp,
        trustedByUserId: owner,
      }),
    ],
  ]);
  const current = () => {
    const active = versions.get(plugin.activeVersion);
    if (active === undefined)
      throw new Error("Active test version is missing.");
    return {
      plugin,
      active,
      versions: [...versions.keys()].sort().reverse() as never,
    };
  };
  const repository = PluginRepository.of({
    list: () => Effect.succeed([current()]),
    find: (_target, id) =>
      id === plugin.id
        ? Effect.succeed(current())
        : Effect.fail(new PluginNotFound()),
    findVersion: (id, version) => {
      const found = id === plugin.id ? versions.get(version) : undefined;
      return found ? Effect.succeed(found) : Effect.fail(new PluginNotFound());
    },
    insert: () => Effect.die("not used"),
    insertVersion: (_target, version, activate, updatedAt) =>
      Effect.sync(() => {
        insertVersionCalls += 1;
        versions.set(version.version, version);
        if (activate) {
          plugin = {
            ...plugin,
            activeVersion: version.version,
            healthStatus: "unchecked",
            updatedAt,
          };
        }
      }),
    updateState: (_target, id, input, updatedAt) => {
      if (id !== plugin.id) return Effect.fail(new PluginNotFound());
      return Effect.sync(() => {
        plugin = {
          ...plugin,
          enabled: input.enabled ?? plugin.enabled,
          activeVersion: input.activeVersion ?? plugin.activeVersion,
          healthStatus:
            input.healthStatus ??
            (input.activeVersion === undefined
              ? plugin.healthStatus
              : "unchecked"),
          updatedAt,
          ...(input.removedAt === undefined
            ? {}
            : { removedAt: input.removedAt }),
        };
      });
    },
    listEffectiveForThread: () => Effect.succeed([current()]),
    listEffectiveForUser: () => Effect.succeed([current()]),
    findAuthorizedInvocation: () => Effect.succeed(current()),
    recordInvocation: () => Effect.void,
    getWorkspacePolicy: () => Effect.succeed(true),
    setWorkspacePolicy: () => Effect.void,
  });
  const layer = PluginService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.succeed(PluginRepository, repository),
        Layer.succeed(
          EnvironmentVariableRepository,
          {} as EnvironmentVariableRepository["Service"],
        ),
        Layer.succeed(
          McpServerRepository,
          {} as McpServerRepository["Service"],
        ),
        Layer.succeed(
          SettingsAudit,
          SettingsAudit.of({ record: () => Effect.void }),
        ),
        Layer.succeed(
          WorkspacePolicyService,
          WorkspacePolicyService.of({
            get: () => Effect.die("unused"),
            update: () => Effect.die("unused"),
            evaluateForUser: options.evaluateForUser ?? (() => Effect.void),
          }),
        ),
      ),
    ),
  );
  return {
    firstPreview,
    layer,
    state: current,
    insertVersionCalls: () => insertVersionCalls,
  };
};

const audit = { userId: owner, requestId: "plugin-service-test" };

describe("PluginService", () => {
  it("keeps the active version after invalid updates, activates reviewed updates, and rolls back", async () => {
    const test = await harness();
    const secondBundle = bundle("2.0.0");
    const secondPreview = await Effect.runPromise(
      previewPluginImport(secondBundle),
    );
    const run = <A, E>(effect: Effect.Effect<A, E, PluginService>) =>
      Effect.runPromise(effect.pipe(Effect.provide(test.layer)));

    await expect(
      run(
        Effect.gen(function* () {
          const service = yield* PluginService;
          return yield* service.update(
            target,
            pluginId,
            secondBundle,
            test.firstPreview.integrity,
            grantedTools(),
            true,
            audit,
          );
        }),
      ),
    ).rejects.toBeInstanceOf(PluginIntegrityConflict);
    expect(test.insertVersionCalls()).toBe(0);
    expect(test.state()).toMatchObject({
      plugin: { activeVersion: "1.0.0" },
      versions: ["1.0.0"],
    });

    await run(
      Effect.gen(function* () {
        const service = yield* PluginService;
        yield* service.update(
          target,
          pluginId,
          secondBundle,
          secondPreview.integrity,
          grantedTools(),
          true,
          audit,
        );
        yield* service.changeState(
          target,
          pluginId,
          { activeVersion: "1.0.0" as never },
          audit,
        );
      }),
    );
    expect(test.insertVersionCalls()).toBe(1);
    expect(test.state()).toMatchObject({
      plugin: { activeVersion: "1.0.0", healthStatus: "unchecked" },
      versions: ["2.0.0", "1.0.0"],
    });

    await expect(
      run(
        Effect.gen(function* () {
          const service = yield* PluginService;
          return yield* service.update(
            target,
            pluginId,
            secondBundle,
            secondPreview.integrity,
            grantedTools(),
            true,
            audit,
          );
        }),
      ),
    ).rejects.toBeInstanceOf(PluginIntegrityConflict);
    expect(test.state().plugin.activeVersion).toBe("1.0.0");
  });

  it("rejects permissions that were not requested before storing a version", async () => {
    const test = await harness();
    const secondBundle = bundle("2.0.0");
    const secondPreview = await Effect.runPromise(
      previewPluginImport(secondBundle),
    );
    const invalidGrants = {
      ...grantedTools(),
      networkDestinations: ["api.example.com" as never],
    };
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PluginService;
          return yield* service.update(
            target,
            pluginId,
            secondBundle,
            secondPreview.integrity,
            invalidGrants,
            true,
            audit,
          );
        }).pipe(Effect.provide(test.layer)),
      ),
    ).rejects.toBeInstanceOf(PluginPermissionInvalid);
    expect(test.insertVersionCalls()).toBe(0);
    expect(test.state().plugin.activeVersion).toBe("1.0.0");
  });

  it("applies secret and MCP policy to personal plugin admission without affecting workspace plugins", async () => {
    const grants: PluginGrantedPermissions = {
      ...grantedTools(),
      secretReferences: [
        {
          name: "PLUGIN_TOKEN" as never,
          reference: {
            version: 1,
            kind: "environment-variable",
            id: "plugin-policy-secret" as never,
          },
        },
      ],
      mcpServerIds: ["mcp_00000000-0000-4000-8000-000000000045" as never],
    };
    const principal = { userId: owner } satisfies Principal;
    const projectId = "prj_00000000-0000-4000-8000-000000000045" as never;
    const resolve = (layer: Awaited<ReturnType<typeof harness>>["layer"]) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PluginService;
          return yield* service.resolveForThread(principal, projectId);
        }).pipe(Effect.provide(layer)),
      );

    const actions: Array<WorkspacePolicyAction> = [];
    const allowed = await harness({
      grants,
      evaluateForUser: (_userId, action) =>
        Effect.sync(() => {
          actions.push(action);
        }),
    });
    await expect(resolve(allowed.layer)).resolves.toHaveLength(1);
    expect(actions).toEqual([
      { kind: "secret.use-personal-override" },
      { kind: "mcp.use-personal-override" },
    ]);

    const secretDenied = await harness({
      grants,
      evaluateForUser: () =>
        Effect.fail(
          new WorkspacePolicyDenied({
            reason: "personal-secret-overrides-disabled",
          }),
        ),
    });
    await expect(resolve(secretDenied.layer)).resolves.toEqual([]);
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const service = yield* PluginService;
          return yield* service.changeState(
            target,
            pluginId,
            { enabled: true },
            audit,
          );
        }).pipe(Effect.provide(secretDenied.layer)),
      ),
    ).rejects.toMatchObject({
      _tag: "WorkspacePolicyDenied",
      reason: "personal-secret-overrides-disabled",
    });

    const mcpDenied = await harness({
      grants,
      evaluateForUser: (_userId, action) =>
        action.kind === "mcp.use-personal-override"
          ? Effect.fail(
              new WorkspacePolicyDenied({
                reason: "personal-mcp-overrides-disabled",
              }),
            )
          : Effect.void,
    });
    await expect(resolve(mcpDenied.layer)).resolves.toEqual([]);

    const workspace = await harness({
      grants,
      target: { scope: "workspace", id: "plugin-policy-workspace" as never },
      evaluateForUser: () =>
        Effect.die("workspace plugin policy was evaluated"),
    });
    await expect(resolve(workspace.layer)).resolves.toHaveLength(1);
  });
});
