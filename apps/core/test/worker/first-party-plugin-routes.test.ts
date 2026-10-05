import { env } from "cloudflare:test";
import { Principal, type UserId } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";
import { executeCode } from "../../src/plugins/code/providers/quickjs.js";
import { getCodeWasm } from "../../src/plugins/code/providers/wasm.js";
import { createCodeTools } from "../../src/plugins/code/tools.js";
import { admitPluginCall } from "../../src/plugins/host.js";
import {
  pluginToolSet,
  resolveCapabilities,
} from "../../src/plugins/resolution.js";
import { resolveSubmissionPluginTools } from "../../src/plugins/submission-tools.js";
import { createExaWebProvider } from "../../src/plugins/web/providers/exa.js";
import { webCapabilityInvoker } from "../../src/plugins/web/tools.js";
import { settingsRoutes } from "../../src/settings/routes.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

const owner = "plugin-owner" as UserId;
const member = "plugin-member" as UserId;
const solo = "plugin-solo" as UserId;
const workspaceId = "plugin-workspace";
const workspaceSlug = "plugin-routes";
const projectId = "prj_00000000-0000-4000-8000-000000000061";
const threadId = "thr_00000000-0000-4000-8000-000000000061";
const memberKey = "member-personal-exa-key";
const workspaceKey = "workspace-exa-key";
const deploymentKey = "deployment-exa-key";

const deployed: Bindings = {
  DB: env.DB,
  DX_RUNTIME_MODE: "deployed",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
  DX_INSTALLED_PLUGINS: "search",
  EXA_API_KEY: deploymentKey,
};

const principal = (userId: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId,
    credentialScopes: ["personal", "workspace"],
  });

const createApp = (userId: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(userId));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app;
};

const call = async (
  userId: UserId,
  path: string,
  method: "GET" | "PUT" | "DELETE" = "GET",
  body?: unknown,
  bindings: Bindings = deployed,
) => {
  const response = await createApp(userId).request(
    `/settings${path}`,
    {
      method,
      ...(body === undefined
        ? {}
        : {
            headers: { "content-type": "application/json" },
            body: JSON.stringify(body),
          }),
    },
    bindings,
  );
  return {
    status: response.status,
    // biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
    body: (await response.json()) as any,
  };
};

const personal = "/personal/first-party-plugins";
const workspace = `/workspaces/${workspaceSlug}/first-party-plugins`;

// biome-ignore lint/suspicious/noExplicitAny: response shapes are asserted below.
const search = (body: any) =>
  body.data.plugins.find((plugin: { id: string }) => plugin.id === "search");

beforeEach(async () => {
  await env.DB.batch([
    ...[owner, member, solo].map((id) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, id, `${id}@example.com`, 1, 1),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Plugin Routes", workspaceSlug, 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("plugin-owner-member", workspaceId, owner, "owner", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("plugin-member-member", workspaceId, member, "member", 1),
    env.DB.prepare(
      `INSERT INTO projects (
         id, owner_user_id, workspace_id, name, runner_profile_id,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, 'a1.medium', ?, ?)`,
    ).bind(
      projectId,
      member,
      workspaceId,
      "Plugin Project",
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      threadId,
      projectId,
      member,
      "2026-10-01T00:00:00.000Z",
      "2026-10-01T00:00:00.000Z",
    ),
  ]);
});

describe("Exa transport in workerd", () => {
  it("uses a redirect mode the Workers runtime accepts", async () => {
    // The legacy adapter used redirect "error", which workerd rejects before
    // any request is sent; the deployed preview failed every Exa call.
    expect(
      () => new Request("https://api.exa.ai/search", { redirect: "error" }),
    ).toThrow();
    let seen: RequestRedirect | undefined;
    const provider = createExaWebProvider(
      Redacted.make("k"),
      async (input, init) => {
        seen = new Request(input, init).redirect;
        return Response.json({ results: [] });
      },
    );
    await provider.webSearch({ objective: "redirect mode" });
    expect(seen).toBe("manual");
  });
});

describe("first-party plugin settings in workerd with real D1", () => {
  it("lists always-on Code without a key and meters QuickJS without fixture substitution", async () => {
    const threadPlugin = {
      pluginId: "code",
      capabilities: ["code.execute"],
    } as const;
    for (const mode of ["local", "deployed"] as const) {
      const bindings = {
        ...deployed,
        DX_RUNTIME_MODE: mode,
        DX_INSTALLED_PLUGINS: "",
      };
      const listed = await call(member, personal, "GET", undefined, bindings);
      expect(listed.status).toBe(200);
      expect(listed.body.data.plugins[0]).toMatchObject({
        id: "code",
        alwaysOn: true,
        providers: [{ id: "quickjs", credentialLabel: null }],
        effective: {
          status: "active",
          provider: { providerId: "quickjs", scope: "deployment" },
        },
      });
      const context = { db: env.DB, bindings };
      const admitted = await admitPluginCall(
        context,
        threadId,
        threadPlugin,
        "code.execute",
      );
      if (!admitted.admitted) throw new Error(admitted.reason);
      expect(admitted.configuration.credential).toBeUndefined();
      const tools = createCodeTools(
        [
          {
            id: "fixture",
            name: "fixture",
            endpoint: "https://example.com/mcp",
            timeoutMs: 1000,
            authenticated: false,
            tools: ["unused"],
          },
        ],
        { threadId, submissionId: null },
        threadPlugin,
        () => context,
      );
      const execute = tools.find((tool) => tool.name === "code_exec");
      const search = tools.find((tool) => tool.name === "tool_search");
      if (!execute || !search) throw new Error("Code tools must mount");
      expect(
        await execute.run({
          data: { code: 'text("workerd")' },
          signal: new AbortController().signal,
        } as never),
      ).toBe("workerd");
      expect(await search.run({ data: { query: "" } } as never)).toContain(
        'import { unused } from "fixture"',
      );
    }
    const rows = await env.DB.prepare(
      "SELECT provider_id, credential_scope, units FROM plugin_usage_event WHERE thread_id = ? AND plugin_id = 'code'",
    )
      .bind(threadId)
      .all();
    expect(rows.results).toEqual([
      { provider_id: "quickjs", credential_scope: "deployment", units: 1 },
      { provider_id: "quickjs", credential_scope: "deployment", units: 1 },
    ]);
    const bindings = { ...deployed, DX_INSTALLED_PLUGINS: "" };
    expect(
      (
        await call(
          member,
          `${personal}/code/configuration`,
          "PUT",
          { providerId: "quickjs", credential: "not-needed" },
          bindings,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await call(
          owner,
          `${workspace}/code/enablement`,
          "PUT",
          { enablement: "disabled" },
          bindings,
        )
      ).status,
    ).toBe(400);
    expect(
      (
        await admitPluginCall(
          { db: env.DB, bindings },
          threadId,
          threadPlugin,
          "code.execute",
        )
      ).admitted,
    ).toBe(true);
  });

  it("interrupts synchronous QuickJS loops in workerd and can execute again", async () => {
    const wasm = await getCodeWasm();
    await expect(
      executeCode(wasm, [], "while (true) {}", async () => null),
    ).rejects.toThrow();
    expect(await executeCode(wasm, [], 'text("alive")', async () => null)).toBe(
      "alive",
    );
  });

  it("lists only the always-on Code and Execution when the deployment installed no plugin", async () => {
    const { DX_INSTALLED_PLUGINS: _, ...uninstalled } = deployed;
    const listed = await call(solo, personal, "GET", undefined, uninstalled);
    expect(listed.status).toBe(200);
    expect(
      listed.body.data.plugins.map((plugin: { id: string }) => plugin.id),
    ).toEqual(["code", "execution"]);
    // Execution is a required slot: never disabled, and its keys belong to
    // the Orb Providers routes, which build the provider's template.
    for (const [path, body] of [
      ["enablement", { enablement: "disabled" }],
      ["configuration", { providerId: "e2b", credential: "e2b-key" }],
    ] as const)
      expect(
        (
          await call(
            solo,
            `${personal}/execution/${path}`,
            "PUT",
            body,
            uninstalled,
          )
        ).status,
      ).toBe(400);
    // Workspace settings keep their membership context with nothing installed.
    expect(
      (await call(member, workspace, "GET", undefined, uninstalled)).status,
    ).toBe(200);
    expect(
      (
        await call(
          solo,
          `${personal}/search/enablement`,
          "PUT",
          { enablement: "enabled" },
          uninstalled,
        )
      ).status,
    ).toBe(404);
    expect(
      pluginToolSet(
        await resolveCapabilities(
          { userId: solo },
          { db: env.DB, bindings: uninstalled },
        ),
      ),
    ).toEqual([{ pluginId: "code", capabilities: ["code.execute"] }]);
  });

  it("resolves deployment, then personal configuration, without returning the credential", async () => {
    const initial = search((await call(solo, personal)).body);
    expect(initial).toMatchObject({
      enablement: null,
      configuration: null,
      inherited: { workspace: null, deployment: { providerId: "exa" } },
      effective: {
        status: "active",
        provider: { providerId: "exa", scope: "deployment" },
      },
    });

    const configured = await call(
      solo,
      `${personal}/search/configuration`,
      "PUT",
      {
        providerId: "exa",
        credential: "solo-personal-key",
      },
    );
    expect(configured.status).toBe(200);
    expect(search(configured.body)).toMatchObject({
      configuration: { providerId: "exa" },
      effective: { status: "active", provider: { scope: "personal" } },
    });
    expect(JSON.stringify(configured.body)).not.toContain("solo-personal-key");
    const row = await env.DB.prepare(
      "SELECT * FROM plugin_setting WHERE scope = 'personal' AND target_id = ?",
    )
      .bind(solo)
      .first();
    expect(JSON.stringify(row)).not.toContain("solo-personal-key");

    const removed = await call(
      solo,
      `${personal}/search/configuration`,
      "DELETE",
    );
    expect(search(removed.body).effective.provider.scope).toBe("deployment");

    const disabled = await call(solo, `${personal}/search/enablement`, "PUT", {
      enablement: "disabled",
    });
    expect(search(disabled.body).effective).toEqual({
      status: "disabled",
      by: "personal",
    });
  });

  it("reports no provider when nothing is configured anywhere", async () => {
    const { EXA_API_KEY: _, ...keyless } = deployed;
    expect(
      search((await call(solo, personal, "GET", undefined, keyless)).body),
    ).toMatchObject({
      inherited: { deployment: { providerId: null } },
      effective: { status: "no-provider" },
    });
  });

  it("keeps a workspace disable absolute for members, even with personal enabled", async () => {
    await call(member, `${personal}/search/enablement`, "PUT", {
      enablement: "enabled",
    });
    const denied = await call(member, `${workspace}/search/enablement`, "PUT", {
      enablement: "disabled",
    });
    expect(denied.status).toBe(403);

    const disabled = await call(
      owner,
      `${workspace}/search/enablement`,
      "PUT",
      {
        enablement: "disabled",
      },
    );
    expect(disabled.status).toBe(200);
    expect(search(disabled.body).effective).toEqual({
      status: "disabled",
      by: "workspace",
    });
    const memberView = search((await call(member, personal)).body);
    expect(memberView).toMatchObject({
      enablement: "enabled",
      inherited: { workspace: { enablement: "disabled" } },
      effective: { status: "disabled", by: "workspace" },
    });
    expect(
      pluginToolSet(
        await resolveCapabilities(
          { userId: member },
          { db: env.DB, bindings: deployed },
        ),
      ),
    ).toEqual([{ pluginId: "code", capabilities: ["code.execute"] }]);
  });

  it("resolves provider, key, and scope live on every call in an existing Thread", async () => {
    const context = { db: env.DB, bindings: deployed };
    const tools = pluginToolSet(
      await resolveCapabilities({ userId: member }, context),
    );
    expect(tools).toEqual([
      { pluginId: "search", capabilities: ["web.search", "web.read"] },
      { pluginId: "code", capabilities: ["code.execute"] },
    ]);
    const [searchPlugin] = tools;
    if (searchPlugin === undefined) throw new Error("Search must resolve.");
    const keys: Array<string | null> = [];
    const transport = vi
      .fn<typeof fetch>()
      .mockImplementation(async (_url, init) => {
        keys.push(new Headers(init?.headers).get("x-api-key"));
        return Response.json({
          results: [{ url: "https://iana.org/", text: "IANA" }],
        });
      });
    // One Thread, one submission's tool set, several calls over time.
    const invoke = webCapabilityInvoker(
      () => context,
      { threadId, submissionId: "sub_live" },
      searchPlugin,
      transport,
    );
    const searchOnce = () =>
      invoke("web.search", (provider) =>
        provider.webSearch?.({ objective: "iana" }),
      );

    await searchOnce();
    await call(owner, `${workspace}/search/configuration`, "PUT", {
      providerId: "exa",
      credential: workspaceKey,
    });
    await searchOnce();
    await call(member, `${personal}/search/configuration`, "PUT", {
      providerId: "exa",
      credential: memberKey,
    });
    await searchOnce();

    // Only workspace admins change the policy.
    expect(
      (
        await call(member, `${workspace}/policy`, "PUT", {
          allowPersonalOverrides: false,
        })
      ).status,
    ).toBe(403);
    const policy = await call(owner, `${workspace}/policy`, "PUT", {
      allowPersonalOverrides: false,
    });
    expect(policy.status).toBe(200);
    expect(search(policy.body).personalOverridesAllowed).toBe(false);
    // Re-sending the current value is still a write members may not make.
    expect(
      (
        await call(member, `${workspace}/policy`, "PUT", {
          allowPersonalOverrides: false,
        })
      ).status,
    ).toBe(403);
    const memberView = search((await call(member, personal)).body);
    expect(memberView).toMatchObject({
      configuration: { providerId: "exa" },
      personalOverridesAllowed: false,
      effective: { status: "active", provider: { scope: "workspace" } },
    });
    const rejected = await call(
      member,
      `${personal}/search/configuration`,
      "PUT",
      { providerId: "exa", credential: "another-key" },
    );
    expect(rejected.status).toBe(403);
    expect(rejected.body.data.code).toBe("PLUGIN_PERSONAL_OVERRIDE_DENIED");
    await searchOnce();

    // Each call used the configuration effective at that moment.
    expect(keys).toEqual([
      deploymentKey,
      workspaceKey,
      memberKey,
      workspaceKey,
    ]);
    const rows = await env.DB.prepare(
      `SELECT submission_id, credential_scope, units, outcome, owner_user_id,
              workspace_id, project_id
       FROM plugin_usage_event WHERE thread_id = ? ORDER BY occurred_at, rowid`,
    )
      .bind(threadId)
      .all();
    expect(rows.results.map((row) => row.credential_scope)).toEqual([
      "deployment",
      "workspace",
      "personal",
      "workspace",
    ]);
    expect(rows.results[0]).toEqual({
      submission_id: "sub_live",
      credential_scope: "deployment",
      units: 1,
      outcome: "success",
      owner_user_id: member,
      workspace_id: workspaceId,
      project_id: projectId,
    });

    // Disabling fails the next call closed; nothing is metered.
    await call(owner, `${workspace}/search/enablement`, "PUT", {
      enablement: "disabled",
    });
    expect(
      await admitPluginCall(context, threadId, searchPlugin, "web.search"),
    ).toEqual({ admitted: false, reason: "disabled" });
    await expect(searchOnce()).rejects.toMatchObject({ code: "unavailable" });
    expect(transport).toHaveBeenCalledTimes(4);
  });

  it("records each submission's tool set once and reuses it on retry", async () => {
    const context = { db: env.DB, bindings: deployed };
    expect(
      await resolveSubmissionPluginTools(context, threadId, "sub_a"),
    ).toEqual([
      { pluginId: "search", capabilities: ["web.search", "web.read"] },
      { pluginId: "code", capabilities: ["code.execute"] },
    ]);
    await call(member, `${personal}/search/enablement`, "PUT", {
      enablement: "disabled",
    });
    // Retry or recovery of the same submission keeps its recorded tools.
    expect(
      await resolveSubmissionPluginTools(context, threadId, "sub_a"),
    ).toEqual([
      { pluginId: "search", capabilities: ["web.search", "web.read"] },
      { pluginId: "code", capabilities: ["code.execute"] },
    ]);
    // The next submission sees the change.
    expect(
      await resolveSubmissionPluginTools(context, threadId, "sub_b"),
    ).toEqual([{ pluginId: "code", capabilities: ["code.execute"] }]);
    const recorded = await env.DB.prepare(
      "SELECT submission_id, owner_user_id, tool_set_json FROM submission_plugin_tools WHERE thread_id = ? ORDER BY submission_id",
    )
      .bind(threadId)
      .all();
    expect(recorded.results).toEqual([
      {
        submission_id: "sub_a",
        owner_user_id: member,
        tool_set_json: JSON.stringify([
          { pluginId: "search", capabilities: ["web.search", "web.read"] },
          { pluginId: "code", capabilities: ["code.execute"] },
        ]),
      },
      {
        submission_id: "sub_b",
        owner_user_id: member,
        tool_set_json: JSON.stringify([
          { pluginId: "code", capabilities: ["code.execute"] },
        ]),
      },
    ]);
    await expect(
      resolveSubmissionPluginTools(context, "thr_missing", "sub_c"),
    ).rejects.toThrow("PLUGIN_TOOLS_THREAD_NOT_FOUND");
  });

  it("records deployment-scope usage and makes no network call in local runtime", async () => {
    const local: Bindings = { ...deployed, DX_RUNTIME_MODE: "local" };
    const [localPin] = pluginToolSet(
      await resolveCapabilities(
        { userId: member },
        { db: env.DB, bindings: local },
      ),
    );
    if (localPin === undefined) throw new Error("Search must resolve.");
    const transport = vi.fn<typeof fetch>();
    const output = await webCapabilityInvoker(
      () => ({ db: env.DB, bindings: local }),
      { threadId, submissionId: null },
      localPin,
      transport,
    )("web.read", (provider) =>
      provider.readWebPage?.({ url: "https://example.com/" }),
    );
    expect(output).toContain("No web request was made");
    expect(transport).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare(
        "SELECT provider_id, credential_scope FROM plugin_usage_event WHERE thread_id = ?",
      )
        .bind(threadId)
        .first(),
    ).toEqual({ provider_id: "fixture", credential_scope: "deployment" });

    // Losing the only configuration fails the next call closed, and a
    // capability outside the submission's tool set is never admitted.
    const readOnly = {
      pluginId: "search" as const,
      capabilities: ["web.search" as const],
    };
    const { EXA_API_KEY: _, ...keyless } = deployed;
    expect(
      (
        await admitPluginCall(
          { db: env.DB, bindings: deployed },
          threadId,
          readOnly,
          "web.search",
        )
      ).admitted,
    ).toBe(true);
    expect(
      await admitPluginCall(
        { db: env.DB, bindings: keyless },
        threadId,
        readOnly,
        "web.search",
      ),
    ).toEqual({ admitted: false, reason: "no-provider" });
    expect(
      await admitPluginCall(
        { db: env.DB, bindings: deployed },
        threadId,
        readOnly,
        "web.read",
      ),
    ).toEqual({ admitted: false, reason: "capability-unavailable" });
  });
});
