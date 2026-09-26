import { env } from "cloudflare:test";
import { pluginPermissionsEmpty, WorkspacePolicyDenied } from "@dx/domain";
import { Effect, Layer } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import {
  invokePlugin,
  invokePluginTrigger,
  PluginExecutionForbidden,
  PluginIsolation,
  type PluginIsolationInput,
} from "../../src/settings/plugins/execution.js";
import {
  type PluginPreview,
  previewPluginImport,
} from "../../src/settings/plugins/import.js";

const owner = "plugin-runtime-owner";
const workspaceId = "plugin-runtime-workspace";
const projectId = "prj_00000000-0000-4000-8000-000000000045";
const threadId = "thr_00000000-0000-4000-8000-000000000045";
const pluginId = "plg_00000000-0000-4000-8000-000000000045";
const mcpId = "mcp_00000000-0000-4000-8000-000000000045";
const timestamp = "2026-08-23T00:00:00.000Z";
const source =
  "export const tools = { summarize: async ({ input }) => input };";

const requestedPermissions = {
  tools: ["summarize"],
  commands: ["summarize-selection"],
  lifecycle: ["agent-start"],
  uiSurfaces: ["runtime-status"],
  networkDestinations: ["api.example.com"],
  secretNames: ["PLUGIN_TOKEN"],
  filesystem: ["project-read"],
  mcpServerIds: [mcpId],
  agentCapabilities: ["thread-metadata"],
  triggers: ["receive-event"],
};

const manifest = {
  schemaVersion: 1,
  name: "runtime-policy",
  displayName: "Runtime policy",
  description: "Verifies deny-default plugin invocation policy.",
  version: "1.0.0",
  entrypoint: "main.mjs",
  tools: [{ name: "summarize", description: "Summarize input." }],
  commands: [
    {
      name: "summarize-selection",
      title: "Summarize selection",
      description: "Invoke the granted tool.",
      tool: "summarize",
    },
  ],
  lifecycle: [{ event: "agent-start" }],
  triggers: [
    {
      name: "receive-event",
      description: "Receive an authenticated event.",
      source: "webhook",
      event: "build.completed",
      action: "receive-event",
      idempotent: true,
    },
  ],
  uiSurfaces: [
    {
      id: "runtime-status",
      location: "settings-card",
      title: "Runtime status",
      description: "Validated metadata only.",
    },
  ],
  permissions: requestedPermissions,
};

const bundle = {
  source: { type: "browser-files" as const, label: "Reviewed runtime files" },
  files: [
    {
      path: "plugin.json",
      kind: "file" as const,
      mediaType: "application/json",
      encoding: "utf-8" as const,
      content: JSON.stringify(manifest),
    },
    {
      path: "main.mjs",
      kind: "file" as const,
      mediaType: "text/javascript",
      encoding: "utf-8" as const,
      content: source,
    },
  ],
};

const bindings = { DB: env.DB, DX_ENV: "test" } as Bindings;

let preview: PluginPreview;

beforeEach(async () => {
  preview = await Effect.runPromise(previewPluginImport(bundle));
  const grants = {
    ...pluginPermissionsEmpty(),
    tools: ["summarize"],
    triggers: ["receive-event"],
  };
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Plugin Owner", "plugin-runtime@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, owner, "Plugin project", timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO trusted_plugin (
         id, scope, target_id, name, enabled, active_version, health_status,
         created_at, updated_at
       ) VALUES (?, 'personal', ?, ?, 1, '1.0.0', 'unchecked', ?, ?)`,
    ).bind(pluginId, owner, manifest.name, timestamp, timestamp),
    env.DB.prepare(
      `INSERT INTO trusted_plugin_version (
         plugin_id, version, manifest_json, grants_json, source_json,
         integrity, trusted, trusted_at, trusted_by_user_id
       ) VALUES (?, '1.0.0', ?, ?, ?, ?, 1, ?, ?)`,
    ).bind(
      pluginId,
      JSON.stringify(preview.manifest),
      JSON.stringify(grants),
      JSON.stringify(preview.source),
      preview.integrity,
      timestamp,
      owner,
    ),
    ...preview.files.map((file) =>
      env.DB.prepare(
        `INSERT INTO trusted_plugin_file (
           plugin_id, version, path, media_type, content, size_bytes, integrity
         ) VALUES (?, '1.0.0', ?, ?, ?, ?, ?)`,
      ).bind(
        pluginId,
        file.path,
        file.mediaType,
        file.content,
        file.sizeBytes,
        file.integrity,
      ),
    ),
    env.DB.prepare(
      `INSERT INTO threads (
         id, project_id, owner_user_id, plugin_snapshot_json,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).bind(
      threadId,
      projectId,
      owner,
      JSON.stringify([
        {
          id: pluginId,
          version: "1.0.0",
          name: manifest.name,
          scope: "personal",
          integrity: preview.integrity,
        },
      ]),
      timestamp,
      timestamp,
    ),
  ]);
});

const projectSandbox = {
  readdir: () => Promise.reject(new Error("filesystem was not granted")),
} as never;

describe("trusted plugin runtime policy", () => {
  it("dispatches a trigger only through the pinned reauthorized plugin version", async () => {
    const triggerId = "trg_00000000-0000-4000-8000-000000000045";
    await env.DB.prepare(
      `INSERT INTO plugin_trigger (
         id, owner_user_id, plugin_id, plugin_version, capability_name,
         source, event_type, action_name, idempotent, status, capability_hash,
         created_at, updated_at, rotated_at
       ) VALUES (?, ?, ?, '1.0.0', 'receive-event', 'webhook',
                 'build.completed', 'receive-event', 1, 'active', ?, ?, ?, ?)`,
    )
      .bind(
        triggerId,
        owner,
        pluginId,
        "a".repeat(64),
        timestamp,
        timestamp,
        timestamp,
      )
      .run();
    const invocations: Array<PluginIsolationInput> = [];
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: (input) =>
          Effect.sync(() => {
            invocations.push(input);
            return { result: { accepted: true }, truncated: false };
          }),
      }),
    );
    const result = await Effect.runPromise(
      invokePluginTrigger(
        bindings,
        triggerId,
        "tdl_00000000-0000-4000-8000-000000000045",
        "github:delivery-45",
        "build:45",
        1,
        { build: 45 },
      ).pipe(Effect.provide(isolation)),
    );
    expect(result.attribution).toMatchObject({
      pluginId,
      version: "1.0.0",
      triggerId,
    });
    expect(invocations).toHaveLength(1);
    expect(invocations[0]?.invocation).toMatchObject({
      kind: "trigger",
      name: "receive-event",
      input: {
        event: { build: 45 },
        eventId: "github:delivery-45",
        idempotencyKey: "build:45",
        attempt: 1,
      },
      context: {
        attribution: { triggerId },
        secretNames: [],
        mcp: [],
      },
    });

    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    await expect(
      Effect.runPromise(
        invokePluginTrigger(
          bindings,
          triggerId,
          "tdl_00000000-0000-4000-8000-000000000046",
          "github:delivery-46",
          "build:46",
          1,
          {},
        ).pipe(Effect.provide(isolation)),
      ),
    ).rejects.toBeInstanceOf(PluginExecutionForbidden);
  });

  it("dispatches through the pinned tool with deny defaults, attribution, and payload-free audit", async () => {
    const invocations: Array<PluginIsolationInput> = [];
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: (input) =>
          Effect.sync(() => {
            invocations.push(input);
            return { result: { accepted: true }, truncated: false };
          }),
      }),
    );
    const result = await Effect.runPromise(
      invokePlugin(
        bindings,
        threadId,
        pluginId,
        "1.0.0",
        { kind: "tool", name: "summarize" },
        { payload: "not-audited" },
        projectSandbox,
      ).pipe(Effect.provide(isolation)),
    );

    expect(result).toMatchObject({
      attribution: {
        pluginId,
        version: "1.0.0",
        capability: "summarize",
      },
      result: { accepted: true },
    });
    expect(result.attribution.invocationId).toMatch(/^pinv_/);
    expect(invocations).toHaveLength(1);
    expect(invocations[0]).toMatchObject({
      pluginId,
      version: "1.0.0",
      networkDestinations: [],
      secrets: {},
      projectFiles: [],
      invocation: {
        kind: "tool",
        name: "summarize",
        context: { secretNames: [], mcp: [] },
      },
    });
    expect(invocations[0]?.invocation.context.agent).toBeUndefined();
    expect(invocations[0]?.invocation.context.projectRoot).toBeUndefined();

    const audit = await env.DB.prepare(
      "SELECT * FROM trusted_plugin_invocation_audit WHERE plugin_id = ?",
    )
      .bind(pluginId)
      .first<Record<string, unknown>>();
    expect(audit).toMatchObject({
      invocation_id: result.attribution.invocationId,
      thread_id: threadId,
      plugin_id: pluginId,
      version: "1.0.0",
      capability_kind: "tool",
      capability_name: "summarize",
      outcome: "success",
    });
    expect(JSON.stringify(audit)).not.toContain("not-audited");
    await expect(
      env.DB.prepare(
        "UPDATE trusted_plugin_invocation_audit SET outcome = 'failed' WHERE invocation_id = ?",
      )
        .bind(result.attribution.invocationId)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare(
        "DELETE FROM trusted_plugin_invocation_audit WHERE invocation_id = ?",
      )
        .bind(result.attribution.invocationId)
        .run(),
    ).rejects.toBeDefined();
  });

  it("keeps the Thread's immutable version callable after a reviewed update", async () => {
    const updatedBundle = {
      ...bundle,
      files: bundle.files.map((file) =>
        file.path === "plugin.json"
          ? {
              ...file,
              content: JSON.stringify({ ...manifest, version: "2.0.0" }),
            }
          : {
              ...file,
              content: `${file.content}\n// version 2.0.0`,
            },
      ),
    };
    const updated = await Effect.runPromise(previewPluginImport(updatedBundle));
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO trusted_plugin_version (
           plugin_id, version, manifest_json, grants_json, source_json,
           integrity, trusted, trusted_at, trusted_by_user_id
         ) VALUES (?, '2.0.0', ?, ?, ?, ?, 1, ?, ?)`,
      ).bind(
        pluginId,
        JSON.stringify(updated.manifest),
        JSON.stringify({
          ...pluginPermissionsEmpty(),
          tools: ["summarize"],
        }),
        JSON.stringify(updated.source),
        updated.integrity,
        timestamp,
        owner,
      ),
      ...updated.files.map((file) =>
        env.DB.prepare(
          `INSERT INTO trusted_plugin_file (
             plugin_id, version, path, media_type, content, size_bytes,
             integrity
           ) VALUES (?, '2.0.0', ?, ?, ?, ?, ?)`,
        ).bind(
          pluginId,
          file.path,
          file.mediaType,
          file.content,
          file.sizeBytes,
          file.integrity,
        ),
      ),
      env.DB.prepare(
        "UPDATE trusted_plugin SET active_version = '2.0.0' WHERE id = ?",
      ).bind(pluginId),
    ]);
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: (input) =>
          Effect.succeed({
            result: { sourceVersion: input.version },
            truncated: false,
          }),
      }),
    );

    await expect(
      Effect.runPromise(
        invokePlugin(
          bindings,
          threadId,
          pluginId,
          "1.0.0",
          { kind: "tool", name: "summarize" },
          null,
          projectSandbox,
        ).pipe(Effect.provide(isolation)),
      ),
    ).resolves.toMatchObject({
      attribution: { version: "1.0.0" },
      result: { sourceVersion: "1.0.0" },
    });
  });

  it("rejects ungranted capabilities and immediately blocks calls after disable", async () => {
    let invocationCount = 0;
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: () =>
          Effect.sync(() => {
            invocationCount += 1;
            return { result: null, truncated: false };
          }),
      }),
    );
    const call = (kind: "tool" | "lifecycle", name: string) =>
      Effect.runPromise(
        invokePlugin(
          bindings,
          threadId,
          pluginId,
          "1.0.0",
          { kind, name },
          null,
          projectSandbox,
        ).pipe(Effect.provide(isolation)),
      );

    await expect(call("lifecycle", "agent-start")).rejects.toBeInstanceOf(
      PluginExecutionForbidden,
    );
    expect(invocationCount).toBe(0);
    await env.DB.prepare("UPDATE trusted_plugin SET enabled = 0 WHERE id = ?")
      .bind(pluginId)
      .run();
    await expect(call("tool", "summarize")).rejects.toBeInstanceOf(
      PluginExecutionForbidden,
    );
    expect(invocationCount).toBe(0);
    await expect(
      env.DB.prepare(
        "SELECT outcome FROM trusted_plugin_invocation_audit ORDER BY created_at, invocation_id",
      ).all<{ outcome: string }>(),
    ).resolves.toMatchObject({
      results: [{ outcome: "rejected" }, { outcome: "rejected" }],
    });
  });

  it("lets workspace policy and workspace precedence revoke personal plugins", async () => {
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: () => Effect.succeed({ result: null, truncated: false }),
      }),
    );
    const call = () =>
      Effect.runPromise(
        invokePlugin(
          bindings,
          threadId,
          pluginId,
          "1.0.0",
          { kind: "tool", name: "summarize" },
          null,
          projectSandbox,
        ).pipe(Effect.provide(isolation)),
      );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(workspaceId, "Plugin workspace", "plugin-runtime", 1),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind("plugin-runtime-membership", workspaceId, owner, 1),
      env.DB.prepare(
        "INSERT INTO trusted_plugin_workspace_policy (workspace_id, allow_personal_plugins) VALUES (?, 0)",
      ).bind(workspaceId),
    ]);
    await expect(call()).rejects.toBeInstanceOf(PluginExecutionForbidden);

    await env.DB.prepare(
      "UPDATE trusted_plugin_workspace_policy SET allow_personal_plugins = 1 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    expect(await call()).toMatchObject({ result: null });

    await env.DB.prepare(
      `INSERT INTO trusted_plugin (
         id, scope, target_id, name, enabled, active_version, health_status,
         created_at, updated_at
       ) VALUES (?, 'workspace', ?, ?, 1, '1.0.0', 'unchecked', ?, ?)`,
    )
      .bind(
        "plg_00000000-0000-4000-8000-000000000046",
        workspaceId,
        manifest.name,
        timestamp,
        timestamp,
      )
      .run();
    await expect(call()).rejects.toBeInstanceOf(PluginExecutionForbidden);
  });

  it("re-evaluates secret and MCP policy before personal plugin invocation", async () => {
    let invocationCount = 0;
    const isolation = Layer.succeed(
      PluginIsolation,
      PluginIsolation.of({
        invoke: () =>
          Effect.sync(() => {
            invocationCount += 1;
            return { result: null, truncated: false };
          }),
      }),
    );
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
      ).bind(workspaceId, "Plugin policy workspace", "plugin-policy", 1),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'owner', ?)",
      ).bind("plugin-policy-membership", workspaceId, owner, 1),
    ]);

    const installVersion = async (
      version: string,
      grants: ReturnType<typeof pluginPermissionsEmpty>,
    ) => {
      const reviewed = await Effect.runPromise(
        previewPluginImport({
          ...bundle,
          files: bundle.files.map((file) =>
            file.path === "plugin.json"
              ? {
                  ...file,
                  content: JSON.stringify({ ...manifest, version }),
                }
              : { ...file, content: `${file.content}\n// ${version}` },
          ),
        }),
      );
      await env.DB.batch([
        env.DB.prepare(
          `INSERT INTO trusted_plugin_version (
             plugin_id, version, manifest_json, grants_json, source_json,
             integrity, trusted, trusted_at, trusted_by_user_id
           ) VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        ).bind(
          pluginId,
          version,
          JSON.stringify(reviewed.manifest),
          JSON.stringify(grants),
          JSON.stringify(reviewed.source),
          reviewed.integrity,
          timestamp,
          owner,
        ),
        ...reviewed.files.map((file) =>
          env.DB.prepare(
            `INSERT INTO trusted_plugin_file (
               plugin_id, version, path, media_type, content, size_bytes,
               integrity
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          ).bind(
            pluginId,
            version,
            file.path,
            file.mediaType,
            file.content,
            file.sizeBytes,
            file.integrity,
          ),
        ),
        env.DB.prepare(
          "UPDATE trusted_plugin SET active_version = ? WHERE id = ?",
        ).bind(version, pluginId),
        env.DB.prepare(
          "UPDATE threads SET plugin_snapshot_json = ? WHERE id = ?",
        ).bind(
          JSON.stringify([
            {
              id: pluginId,
              version,
              name: manifest.name,
              scope: "personal",
              integrity: reviewed.integrity,
            },
          ]),
          threadId,
        ),
      ]);
    };
    const call = (version: string) =>
      Effect.runPromise(
        invokePlugin(
          bindings,
          threadId,
          pluginId,
          version,
          { kind: "tool", name: "summarize" },
          null,
          projectSandbox,
        ).pipe(Effect.provide(isolation), Effect.flip),
      );

    await installVersion("2.0.0", {
      ...pluginPermissionsEmpty(),
      tools: ["summarize"],
      secretReferences: [
        {
          name: "PLUGIN_TOKEN",
          reference: {
            version: 1,
            kind: "environment-variable",
            id: "plugin-policy-secret",
          },
        },
      ],
    } as never);
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_personal_secret_overrides = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    const secretDenial = await call("2.0.0");
    expect(secretDenial).toBeInstanceOf(WorkspacePolicyDenied);
    expect(secretDenial).toMatchObject({
      reason: "personal-secret-overrides-disabled",
    });

    await installVersion("3.0.0", {
      ...pluginPermissionsEmpty(),
      tools: ["summarize"],
      mcpServerIds: [mcpId],
    } as never);
    await env.DB.prepare(
      `UPDATE workspace_policy
          SET allow_personal_secret_overrides = 1,
              allow_personal_mcp_overrides = 0
        WHERE workspace_id = ?`,
    )
      .bind(workspaceId)
      .run();
    const mcpDenial = await call("3.0.0");
    expect(mcpDenial).toBeInstanceOf(WorkspacePolicyDenied);
    expect(mcpDenial).toMatchObject({
      reason: "personal-mcp-overrides-disabled",
    });
    expect(invocationCount).toBe(0);
    await expect(
      env.DB.prepare(
        "SELECT outcome FROM trusted_plugin_invocation_audit ORDER BY created_at, invocation_id",
      ).all<{ outcome: string }>(),
    ).resolves.toMatchObject({
      results: [{ outcome: "rejected" }, { outcome: "rejected" }],
    });
  });
});
