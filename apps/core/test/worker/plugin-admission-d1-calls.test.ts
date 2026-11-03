import { env } from "cloudflare:test";
import { Effect, Redacted } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { createCodeTools } from "../../src/plugins/code/tools.js";
import { admitPluginCall } from "../../src/plugins/host.js";
import {
  encryptPluginCredential,
  putPluginConfiguration,
} from "../../src/plugins/settings-store-d1.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/config-encryption.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { countD1Calls } from "./d1-call-counter.js";

/**
 * D1 round trips before a first-party plugin call runs (#1496). Every
 * code_exec, tool_search, web_search, and read_web_page call is admitted
 * from current settings, from a Durable Object a continent away from D1 for
 * most people, so each sequential round trip costs about 230 ms. Admission
 * takes exactly one, with or without a workspace and its policy, and still
 * refuses what it refused. The usage row feeds usage and credits, so the
 * call still writes it before its result.
 */

const owner = "admission-owner";
const workspaceId = "admission-workspace";
const projectId = "prj_00000000-0000-4000-8000-000000001498";
const threadId = "thr_00000000-0000-4000-8000-000000001498";
const timestamp = "2026-11-02T00:00:00.000Z";
const code = { pluginId: "code", capabilities: ["code.execute"] } as const;
const search = {
  pluginId: "search",
  capabilities: ["web.search", "web.read"],
} as const;

const bindings: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INSTALLED_PLUGINS: "search",
  EXA_API_KEY: "deployment-exa-key",
};

const counted = () => {
  const counter = countD1Calls(env.DB);
  return {
    counter,
    context: { db: counter.db, bindings: { ...bindings, DB: counter.db } },
  };
};

const join = (workspace: string) =>
  env.DB.batch([
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, 1)",
    ).bind(workspace, workspace, workspace),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, 'member', 1)",
    ).bind(`${workspace}-member`, workspace, owner),
  ]);

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
    ).bind(owner, owner, `${owner}@example.com`),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, 'Admission', ?, ?)",
    ).bind(projectId, owner, timestamp, timestamp),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(threadId, projectId, owner, timestamp, timestamp),
  ]);
});

describe("first-party plugin admission in workerd with real D1", () => {
  it("runs code_exec after one admission round trip and writes its usage row before the result", async () => {
    const { counter, context } = counted();
    const [execute] = createCodeTools(
      [],
      { threadId, submissionId: "sub_admission" },
      code,
      () => context,
    );
    if (execute === undefined) throw new Error("code_exec must mount");

    const output = await execute.run({
      data: { code: 'text("ok")' },
      signal: new AbortController().signal,
    } as never);
    expect(output).toBe("ok");
    const [admission, usage] = counter.calls;
    expect(counter.calls.map(({ method }) => method)).toEqual(["batch", "run"]);
    expect(admission?.sql).toHaveLength(4);
    expect(Number.isFinite(usage?.endedAt)).toBe(true);
    expect(
      await env.DB.prepare(
        "SELECT plugin_id, provider_id, submission_id, units, outcome FROM plugin_usage_event WHERE thread_id = ?",
      )
        .bind(threadId)
        .all(),
    ).toMatchObject({
      results: [
        {
          plugin_id: "code",
          provider_id: "quickjs",
          submission_id: "sub_admission",
          units: 1,
          outcome: "success",
        },
      ],
    });
  });

  it("applies a workspace's policy and keys in the same round trip", async () => {
    await join(workspaceId);
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(bindings),
    );
    for (const [scope, target, key] of [
      ["personal", owner, "personal-exa-key"],
      ["workspace", workspaceId, "workspace-exa-key"],
    ] as const)
      await putPluginConfiguration(env.DB, scope, target, "search", {
        providerId: "exa",
        configuredAt: timestamp,
        envelope: await encryptPluginCredential(
          keyring,
          { scope, targetId: target, pluginId: "search" },
          "exa",
          key,
        ),
      });
    const admitted = async () => {
      const { counter, context } = counted();
      const admission = await admitPluginCall(
        context,
        threadId,
        search,
        "web.search",
      );
      expect(counter.calls.map(({ method }) => method)).toEqual(["batch"]);
      if (!admission.admitted) throw new Error(admission.reason);
      return {
        scope: admission.configuration.scope,
        key: Redacted.value(
          admission.configuration.credential ?? Redacted.make(""),
        ),
      };
    };

    expect(await admitted()).toEqual({
      scope: "personal",
      key: "personal-exa-key",
    });
    await env.DB.prepare(
      "UPDATE workspace_policy SET allow_personal_plugin_overrides = 0 WHERE workspace_id = ?",
    )
      .bind(workspaceId)
      .run();
    expect(await admitted()).toEqual({
      scope: "workspace",
      key: "workspace-exa-key",
    });
    await env.DB.prepare(
      "UPDATE plugin_setting SET enablement = 'disabled' WHERE scope = 'workspace' AND target_id = ?",
    )
      .bind(workspaceId)
      .run();
    const { counter, context } = counted();
    expect(
      await admitPluginCall(context, threadId, search, "web.search"),
    ).toEqual({ admitted: false, reason: "disabled" });
    expect(counter.calls).toHaveLength(1);
  });

  it("refuses an archived or missing Thread, and fails closed without a workspace policy", async () => {
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'archived' WHERE id = ?",
    )
      .bind(threadId)
      .run();
    expect(
      await admitPluginCall(counted().context, threadId, code, "code.execute"),
    ).toEqual({ admitted: false, reason: "thread-unavailable" });
    expect(
      await admitPluginCall(
        counted().context,
        "thr_00000000-0000-4000-8000-000000009999",
        code,
        "code.execute",
      ),
    ).toEqual({ admitted: false, reason: "thread-unavailable" });
    await env.DB.prepare(
      "UPDATE threads SET lifecycle_state = 'active' WHERE id = ?",
    )
      .bind(threadId)
      .run();

    // Search asks the policy; a member's workspace must have one.
    await join(workspaceId);
    await env.DB.prepare("DELETE FROM workspace_policy WHERE workspace_id = ?")
      .bind(workspaceId)
      .run();
    await expect(
      admitPluginCall(counted().context, threadId, search, "web.search"),
    ).rejects.toThrow("policy");
  });
});
