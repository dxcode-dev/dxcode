import { env } from "cloudflare:test";
import { Principal, UserId } from "@dx/domain";
import { Schema } from "effect";
import { Hono } from "hono";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { errorHandler } from "../../src/http/http-errors.js";
import { requestId } from "../../src/http/request-id.js";
import type { AppEnv } from "../../src/http/types.js";
import {
  settingsAuditLogger,
  settingsPersistenceLogger,
} from "../../src/logging.js";
import { settingsRoutes } from "../../src/settings/routes.js";

const userId = (value: string) => Schema.decodeUnknownSync(UserId)(value);
const owner = userId("settings-route-owner");
const outsider = userId("settings-route-outsider");
const member = userId("settings-route-member");
const admin = userId("settings-route-admin");
const principal = (id: UserId) =>
  Schema.decodeUnknownSync(Principal)({
    userId: id,
    credentialScopes: ["personal", "workspace"],
  });

const createSettingsApp = (id: UserId) => {
  const app = new Hono<AppEnv>();
  app.use("*", requestId);
  app.use("*", async (context, next) => {
    context.set("principal", principal(id));
    await next();
  });
  app.route("/settings", settingsRoutes);
  app.onError(errorHandler);
  return app;
};

const insertIdentity = (id: UserId, index: number) =>
  env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
  ).bind(id, `User ${index}`, `settings-${index}@example.com`, 1, 1);

beforeEach(async () => {
  await env.DB.batch([
    insertIdentity(owner, 1),
    insertIdentity(outsider, 2),
    insertIdentity(member, 3),
    insertIdentity(admin, 4),
    env.DB.prepare(
      "UPDATE personal_account SET display_name = ?, username = ? WHERE user_id = ?",
    ).bind("Settings Owner", "settings-owner", owner),
    env.DB.prepare(
      "UPDATE personal_account SET display_name = ?, username = ? WHERE user_id = ?",
    ).bind("Settings Outsider", "settings-outsider", outsider),
    env.DB.prepare(
      "INSERT INTO account (id, issuer, accountId, providerId, userId, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "owner-access-account",
      "https://team.cloudflareaccess.com",
      "owner-subject",
      "cloudflare-access",
      owner,
      1,
      1,
    ),
    env.DB.prepare(
      "INSERT INTO account (id, issuer, accountId, providerId, userId, password, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(
      "outsider-credential-account",
      "",
      outsider,
      "credential",
      outsider,
      "hashed-password",
      1,
      1,
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind("workspace-id", "DX Team", "dx-team", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("owner-member", "workspace-id", owner, "owner", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("regular-member", "workspace-id", member, "member", 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind("other-workspace-id", "Other Team", "other-team", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("admin-member", "other-workspace-id", admin, "admin", 1),
  ]);
});

describe("settings routes in workerd with real D1", () => {
  it("reads only the current user's local profile and authoritative identity", async () => {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("account-project", owner, "Account Project", "now", "now"),
      env.DB.prepare(
        "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
      ).bind("account-thread", "account-project", owner, "now", "now"),
    ]);
    const ownerResponse = await createSettingsApp(owner).request(
      "/settings/personal/account",
      {},
      { DB: env.DB },
    );
    expect(ownerResponse.status).toBe(200);
    const ownerBody = await ownerResponse.json();
    expect(ownerBody).toEqual({
      status: "success",
      data: {
        displayName: "Settings Owner",
        username: "settings-owner",
        email: "settings-1@example.com",
        emailVerified: true,
        identityAuthority: "cloudflare-access",
        threadCount: 1,
        appearance: "dark",
        palette: "daydream",
        terminalTheme: "github",
      },
    });

    const outsiderResponse = await createSettingsApp(outsider).request(
      "/settings/personal/account",
      {},
      { DB: env.DB },
    );
    await expect(outsiderResponse.json()).resolves.toMatchObject({
      data: {
        displayName: "Settings Outsider",
        username: "settings-outsider",
        email: "settings-2@example.com",
        identityAuthority: "local-password",
        threadCount: 0,
        appearance: "dark",
        palette: "daydream",
        terminalTheme: "github",
      },
    });
    expect(JSON.stringify(ownerBody)).not.toContain("settings-outsider");
  });

  it("normalizes and persists current-user profile updates", async () => {
    const response = await createSettingsApp(owner).request(
      "/settings/personal/account",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://dx.test",
        },
        body: JSON.stringify({
          displayName: "  Updated Owner  ",
          username: "  @Updated-Owner  ",
        }),
      },
      { DB: env.DB },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      data: {
        displayName: "Updated Owner",
        username: "updated-owner",
        email: "settings-1@example.com",
      },
    });
    await expect(
      env.DB.prepare(
        "SELECT display_name, username FROM personal_account WHERE user_id = ?",
      )
        .bind(owner)
        .first(),
    ).resolves.toEqual({
      display_name: "Updated Owner",
      username: "updated-owner",
    });
    expect(
      await env.DB.prepare(
        "SELECT username FROM personal_account WHERE user_id = ?",
      )
        .bind(outsider)
        .first("username"),
    ).toBe("settings-outsider");
  });

  it("patches appearance fields without overwriting the other preferences", async () => {
    const response = await createSettingsApp(owner).request(
      "/settings/personal/account/appearance",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://dx.test",
        },
        body: JSON.stringify({
          appearance: "light",
        }),
      },
      { DB: env.DB },
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      status: "success",
      data: {
        appearance: "light",
        palette: "daydream",
        terminalTheme: "github",
      },
    });
    const paletteResponse = await createSettingsApp(owner).request(
      "/settings/personal/account/appearance",
      {
        method: "PATCH",
        headers: {
          "content-type": "application/json",
          origin: "http://dx.test",
        },
        body: JSON.stringify({ palette: "deadpan", terminalTheme: "gruvbox" }),
      },
      { DB: env.DB },
    );
    expect(paletteResponse.status).toBe(200);
    await expect(paletteResponse.json()).resolves.toMatchObject({
      status: "success",
      data: {
        appearance: "light",
        palette: "deadpan",
        terminalTheme: "gruvbox",
      },
    });
    await expect(
      env.DB.prepare(
        "SELECT appearance, palette, terminal_theme FROM personal_account WHERE user_id = ?",
      )
        .bind(owner)
        .first(),
    ).resolves.toEqual({
      appearance: "light",
      palette: "deadpan",
      terminal_theme: "gruvbox",
    });
    expect(
      await env.DB.prepare(
        "SELECT appearance FROM personal_account WHERE user_id = ?",
      )
        .bind(outsider)
        .first("appearance"),
    ).toBe("dark");
  });

  it("remembers composer defaults per user and patches only sent fields", async () => {
    const app = createSettingsApp(owner);
    const patch = (body: unknown) =>
      app.request(
        "/settings/personal/account/composer",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: env.DB },
      );

    const initial = await app.request(
      "/settings/personal/account/composer",
      {},
      { DB: env.DB },
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toEqual({
      status: "success",
      data: { project: null, mode: null, model: null, runnerProfileId: null },
    });

    expect(
      (await patch({ mode: "high", model: "openai/gpt-6-astra" })).status,
    ).toBe(200);
    expect((await patch({ runnerProfileId: "e2b-large" })).status).toBe(200);
    const cleared = await patch({ project: "none", model: null });
    expect(cleared.status).toBe(200);
    await expect(cleared.json()).resolves.toEqual({
      status: "success",
      data: {
        project: "none",
        mode: "high",
        model: null,
        runnerProfileId: "e2b-large",
      },
    });

    const reread = await createSettingsApp(owner).request(
      "/settings/personal/account/composer",
      {},
      { DB: env.DB },
    );
    await expect(reread.json()).resolves.toMatchObject({
      data: { project: "none", mode: "high", runnerProfileId: "e2b-large" },
    });
    const other = await createSettingsApp(outsider).request(
      "/settings/personal/account/composer",
      {},
      { DB: env.DB },
    );
    await expect(other.json()).resolves.toMatchObject({
      data: { project: null, mode: null, model: null, runnerProfileId: null },
    });
  });

  it.each([
    { mode: "extreme" },
    { project: "not-a-project" },
    { model: "no-slash" },
    { runnerProfileId: "Bad Orb" },
  ])("rejects invalid composer defaults %j", async (body) => {
    const response = await createSettingsApp(owner).request(
      "/settings/personal/account/composer",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      },
      { DB: env.DB },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      data: { code: "INVALID_ACCOUNT_PROFILE" },
    });
  });

  it.each([
    [JSON.stringify({ appearance: "sepia" }), "appearance"],
    [JSON.stringify({ palette: "neon" }), "palette"],
    [JSON.stringify({ terminalTheme: "unknown" }), "terminalTheme"],
    [JSON.stringify({ contrast: "high" }), "request"],
    ["{", "request"],
  ])("audits rejected appearance payload %s", async (body, field) => {
    const auditLog = vi
      .spyOn(settingsAuditLogger, "info")
      .mockImplementation(() => {});
    const response = await createSettingsApp(owner).request(
      "/settings/personal/account/appearance",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body,
      },
      { DB: env.DB },
    );

    expect(response.status).toBe(400);
    expect(auditLog).toHaveBeenCalledWith(
      "Settings mutation audited.",
      expect.objectContaining({
        action: "personal_appearance.update",
        fields: field === "request" ? [] : [field],
        outcome: "rejected",
        userId: owner,
      }),
    );
    auditLog.mockRestore();
  });

  it("returns typed invalid, conflict, and read-only identity feedback", async () => {
    const app = createSettingsApp(owner);
    const invalid = await app.request(
      "/settings/personal/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ displayName: "Owner", username: "x" }),
      },
      { DB: env.DB },
    );
    expect(invalid.status).toBe(400);
    await expect(invalid.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "INVALID_ACCOUNT_PROFILE",
        fieldErrors: [{ field: "username" }],
      },
    });

    const duplicate = await app.request(
      "/settings/personal/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Owner",
          username: "SETTINGS-OUTSIDER",
        }),
      },
      { DB: env.DB },
    );
    expect(duplicate.status).toBe(409);
    await expect(duplicate.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "USERNAME_UNAVAILABLE",
        fieldErrors: [{ field: "username" }],
      },
    });

    const identityOverwrite = await app.request(
      "/settings/personal/account",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Owner",
          username: "settings-owner",
          email: "overwritten@example.com",
        }),
      },
      { DB: env.DB },
    );
    expect(identityOverwrite.status).toBe(400);
    expect(
      await env.DB.prepare('SELECT email FROM "user" WHERE id = ?')
        .bind(owner)
        .first("email"),
    ).toBe("settings-1@example.com");
  });

  it("reads and updates only the signed-in user's personal agent instructions", async () => {
    const privateContent = "PRIVATE-ROUTE-INSTRUCTION";
    const persistenceLog = vi
      .spyOn(settingsPersistenceLogger, "info")
      .mockImplementation(() => {});
    const auditLog = vi
      .spyOn(settingsAuditLogger, "info")
      .mockImplementation(() => {});
    const ownerApp = createSettingsApp(owner);

    const initial = await ownerApp.request(
      "/settings/personal/agent-instructions",
      {},
      { DB: env.DB },
    );
    expect(initial.status).toBe(200);
    await expect(initial.json()).resolves.toMatchObject({
      status: "success",
      data: { instructions: "", revision: 0, version: 1 },
    });

    const saved = await ownerApp.request(
      "/settings/personal/agent-instructions",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: privateContent,
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(saved.status).toBe(200);
    await expect(saved.json()).resolves.toMatchObject({
      status: "success",
      data: { instructions: privateContent, revision: 1, version: 1 },
    });

    const outsiderResponse = await createSettingsApp(outsider).request(
      "/settings/personal/agent-instructions",
      {},
      { DB: env.DB },
    );
    await expect(outsiderResponse.json()).resolves.toMatchObject({
      data: { instructions: "", revision: 0 },
    });
    expect(JSON.stringify(persistenceLog.mock.calls)).not.toContain(
      privateContent,
    );
    expect(JSON.stringify(auditLog.mock.calls)).not.toContain(privateContent);
    persistenceLog.mockRestore();
    auditLog.mockRestore();
  });

  it("returns typed size, revision, conflict, and reset feedback", async () => {
    const app = createSettingsApp(owner);
    for (const body of [
      { instructions: "x".repeat(10_001), expectedRevision: 0 },
      { instructions: "valid", expectedRevision: -1 },
      { instructions: "valid", expectedRevision: 0.5 },
    ]) {
      const invalid = await app.request(
        "/settings/personal/agent-instructions",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: env.DB },
      );
      expect(invalid.status).toBe(400);
      await expect(invalid.json()).resolves.toMatchObject({
        status: "error",
        data: {
          code: "INVALID_AGENT_INSTRUCTIONS",
          fieldErrors: expect.any(Array),
        },
      });
    }

    const first = await app.request(
      "/settings/personal/agent-instructions",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "First revision",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(first.status).toBe(200);

    const stale = await app.request(
      "/settings/personal/agent-instructions",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          instructions: "Stale revision",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
        currentRevision: 1,
      },
    });

    const reset = await app.request(
      "/settings/personal/agent-instructions",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ instructions: "", expectedRevision: 1 }),
      },
      { DB: env.DB },
    );
    expect(reset.status).toBe(200);
    await expect(reset.json()).resolves.toMatchObject({
      status: "success",
      data: { instructions: "", revision: 2 },
    });
  });

  it("exposes only the signed-in user's one workspace and hides it without membership", async () => {
    const ownerPersonal = await createSettingsApp(owner).request(
      "/settings/personal",
      {},
      { DB: env.DB },
    );
    expect(ownerPersonal.status).toBe(200);
    await expect(ownerPersonal.json()).resolves.toMatchObject({
      status: "success",
      data: {
        activeScope: "personal",
        workspace: {
          id: "workspace-id",
          displayName: "DX Team",
          shortName: "dx-team",
          lifecycleState: "active",
          role: "owner",
        },
      },
    });

    const memberResponse = await createSettingsApp(member).request(
      "/settings/personal",
      {},
      { DB: env.DB },
    );
    await expect(memberResponse.json()).resolves.toMatchObject({
      data: {
        workspace: { shortName: "dx-team", role: "member" },
      },
    });

    const outsiderResponse = await createSettingsApp(outsider).request(
      "/settings/personal",
      {},
      { DB: env.DB },
    );
    await expect(outsiderResponse.json()).resolves.toEqual({
      status: "success",
      data: { activeScope: "personal", dictationAvailable: false },
    });
  });

  it("accepts only the signed-in member's exact current workspace slug", async () => {
    const authorized = await createSettingsApp(owner).request(
      "/settings/workspaces/dx-team",
      {},
      { DB: env.DB },
    );
    expect(authorized.status).toBe(200);
    await expect(authorized.json()).resolves.toMatchObject({
      data: { id: "workspace-id", shortName: "dx-team", role: "owner" },
    });

    const memberRead = await createSettingsApp(member).request(
      "/settings/workspaces/dx-team",
      {},
      { DB: env.DB },
    );
    expect(memberRead.status).toBe(200);
    await expect(memberRead.json()).resolves.toMatchObject({
      data: { id: "workspace-id", role: "member" },
    });

    for (const [id, slug] of [
      [owner, "other-team"],
      [outsider, "dx-team"],
      [member, "other-team"],
      [admin, "dx-team"],
    ] as const) {
      const forbidden = await createSettingsApp(id).request(
        `/settings/workspaces/${slug}`,
        {},
        { DB: env.DB },
      );
      expect(forbidden.status).toBe(403);
      await expect(forbidden.json()).resolves.toMatchObject({
        status: "error",
        data: { code: "SETTINGS_SCOPE_FORBIDDEN" },
      });
    }
  });

  it("atomically creates the first workspace and rejects concurrent or later membership", async () => {
    const app = createSettingsApp(outsider);
    const create = (displayName: string, shortName: string) =>
      app.request(
        "/settings/workspaces",
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ displayName, shortName }),
        },
        { DB: env.DB },
      );
    const responses = await Promise.all([
      create("  First Workspace  ", "  FIRST-WORKSPACE  "),
      create("Second Workspace", "second-workspace"),
    ]);
    expect(responses.map(({ status }) => status).sort()).toEqual([201, 409]);
    const created = responses.find(({ status }) => status === 201);
    await expect(created?.json()).resolves.toMatchObject({
      status: "success",
      data: {
        displayName: expect.any(String),
        shortName: expect.stringMatching(/^(first|second)-workspace$/),
        lifecycleState: "active",
        role: "owner",
      },
    });
    await expect(
      env.DB.prepare("SELECT COUNT(*) AS count FROM member WHERE userId = ?")
        .bind(outsider)
        .first("count"),
    ).resolves.toBe(1);

    const second = await create("Later Workspace", "later-workspace");
    expect(second.status).toBe(409);
    await expect(second.json()).resolves.toMatchObject({
      data: { code: "WORKSPACE_MEMBERSHIP_EXISTS" },
    });
  });

  it("keeps the stable ID across owner rename and makes only the new slug canonical", async () => {
    const ownerApp = createSettingsApp(owner);
    const updated = await ownerApp.request(
      "/settings/workspaces/dx-team",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "  Renamed DX  ",
          shortName: "  RENAMED-DX  ",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(updated.status).toBe(200);
    const updatedBody = await updated.json();
    expect(updatedBody).toMatchObject({
      status: "success",
      data: {
        id: "workspace-id",
        displayName: "Renamed DX",
        shortName: "renamed-dx",
        lifecycleState: "active",
        revision: 1,
      },
    });
    expect(JSON.stringify(updatedBody)).not.toContain("Other Team");

    const oldSlug = await ownerApp.request(
      "/settings/workspaces/dx-team",
      {},
      { DB: env.DB },
    );
    expect(oldSlug.status).toBe(403);
    const canonical = await ownerApp.request(
      "/settings/workspaces/renamed-dx",
      {},
      { DB: env.DB },
    );
    expect(canonical.status).toBe(200);
    await expect(canonical.json()).resolves.toMatchObject({
      data: { id: "workspace-id", shortName: "renamed-dx" },
    });
  });

  it("returns a typed conflict to the second profile writer", async () => {
    const ownerApp = createSettingsApp(owner);
    const update = (displayName: string) =>
      ownerApp.request(
        "/settings/workspaces/dx-team",
        {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            displayName,
            shortName: "dx-team",
            expectedRevision: 0,
          }),
        },
        { DB: env.DB },
      );

    expect((await update("First Writer")).status).toBe(200);
    const stale = await update("Second Writer");
    expect(stale.status).toBe(409);
    await expect(stale.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "WORKSPACE_PROFILE_CONFLICT",
        currentRevision: 1,
      },
    });
    await expect(
      env.DB.prepare(
        "SELECT name, profileRevision FROM organization WHERE id = ?",
      )
        .bind("workspace-id")
        .first(),
    ).resolves.toEqual({ name: "First Writer", profileRevision: 1 });
  });

  it("enforces global short-name uniqueness and owner/admin mutation roles", async () => {
    const conflict = await createSettingsApp(owner).request(
      "/settings/workspaces/dx-team",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "DX Team",
          shortName: "OTHER-TEAM",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(conflict.status).toBe(409);
    await expect(conflict.json()).resolves.toMatchObject({
      data: {
        code: "WORKSPACE_SHORT_NAME_UNAVAILABLE",
        fieldErrors: [{ field: "shortName" }],
      },
    });

    const adminUpdate = await createSettingsApp(admin).request(
      "/settings/workspaces/other-team",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Admin Renamed",
          shortName: "admin-renamed",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(adminUpdate.status).toBe(200);
    await expect(adminUpdate.json()).resolves.toMatchObject({
      data: {
        id: "other-workspace-id",
        role: "admin",
        shortName: "admin-renamed",
      },
    });

    const memberUpdate = await createSettingsApp(member).request(
      "/settings/workspaces/dx-team",
      {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          displayName: "Member Changed",
          shortName: "member-changed",
          expectedRevision: 0,
        }),
      },
      { DB: env.DB },
    );
    expect(memberUpdate.status).toBe(403);
    await expect(
      env.DB.prepare("SELECT name, slug FROM organization WHERE id = ?")
        .bind("workspace-id")
        .first(),
    ).resolves.toEqual({ name: "DX Team", slug: "dx-team" });
  });

  it("returns 503 when MCP validation encounters malformed persisted data", async () => {
    const mcpServerId = "mcp_00000000-0000-4000-8000-000000000503";
    const skillBundle = {
      source: { type: "browser-files", label: "Reviewed browser folder" },
      files: [
        {
          path: "skill.json",
          kind: "file",
          mediaType: "application/json",
          encoding: "utf-8",
          content: JSON.stringify({
            schemaVersion: 1,
            name: "malformed-mcp-reference",
            description: "Exercise MCP repository schema failure handling.",
            mcpServerIds: [mcpServerId],
          }),
        },
        {
          path: "instructions.md",
          kind: "file",
          mediaType: "text/markdown",
          encoding: "utf-8",
          content: "Use the reviewed MCP server.",
        },
      ],
    };
    const app = createSettingsApp(owner);
    const path = "/settings/personal/skills";
    const request = (route: string, method: "POST" | "PATCH", body: unknown) =>
      app.request(
        route,
        {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify(body),
        },
        { DB: env.DB },
      );
    const preview = await (
      await request(`${path}/preview`, "POST", skillBundle)
    ).json<{ data: { integrity: string } }>();
    const created = await (
      await request(path, "POST", {
        bundle: skillBundle,
        reviewedIntegrity: preview.data.integrity,
      })
    ).json<{ data: { id: string } }>();
    await env.DB.prepare(
      `INSERT INTO mcp_server (
         id, scope, target_id, name, endpoint, transport, timeout_ms, enabled,
         project_ids_json, roles_json, health_status, created_at, updated_at
       ) VALUES (?, 'personal', ?, 'Malformed server', 'not-a-url',
                 'streamable-http', 10000, 1, '[]', '["owner"]',
                 'unchecked', ?, ?)`,
    )
      .bind(
        mcpServerId,
        owner,
        "2026-09-03T00:00:00.000Z",
        "2026-09-03T00:00:00.000Z",
      )
      .run();

    const response = await request(`${path}/${created.data.id}`, "PATCH", {
      enabled: true,
    });

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      data: { code: "SKILLS_UNAVAILABLE" },
    });
    await expect(
      env.DB.prepare("SELECT enabled FROM skill WHERE id = ?")
        .bind(created.data.id)
        .first(),
    ).resolves.toEqual({ enabled: 0 });
  });

  it("serves exact personal/workspace Skills routes with previewed immutable versions and role policy", async () => {
    const makeBundle = (instructions: string) => ({
      source: { type: "browser-files", label: "Reviewed browser folder" },
      files: [
        {
          path: "skill.json",
          kind: "file",
          mediaType: "application/json",
          encoding: "utf-8",
          content: JSON.stringify({
            schemaVersion: 1,
            name: "review-guidelines",
            description: "Review this repository consistently.",
            mcpServerIds: [],
          }),
        },
        {
          path: "instructions.md",
          kind: "file",
          mediaType: "text/markdown",
          encoding: "utf-8",
          content: instructions,
        },
        {
          path: "resources/checklist.md",
          kind: "file",
          mediaType: "text/markdown",
          encoding: "utf-8",
          content: "# Review checklist",
        },
      ],
    });
    const call = (
      app: ReturnType<typeof createSettingsApp>,
      path: string,
      method: "GET" | "POST" | "PATCH" | "DELETE" = "GET",
      body?: unknown,
    ) =>
      app.request(
        path,
        {
          method,
          headers:
            body === undefined ? {} : { "content-type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        { DB: env.DB },
      );
    const personal = "/settings/personal/skills";
    const ownerApp = createSettingsApp(owner);
    const firstBundle = makeBundle("Use the first reviewed version.");
    const firstPreviewResponse = await call(
      ownerApp,
      `${personal}/preview`,
      "POST",
      firstBundle,
    );
    expect(firstPreviewResponse.status).toBe(200);
    const firstPreview = await firstPreviewResponse.json<{
      data: { integrity: string; resources: unknown[] };
    }>();
    expect(firstPreview.data).toMatchObject({
      integrity: expect.stringMatching(/^[a-f0-9]{64}$/),
      resources: [expect.objectContaining({ path: "resources/checklist.md" })],
    });

    const createdResponse = await call(ownerApp, personal, "POST", {
      bundle: firstBundle,
      reviewedIntegrity: firstPreview.data.integrity,
    });
    expect(createdResponse.status).toBe(201);
    const created = await createdResponse.json<{
      data: { id: string; activeVersion: number; enabled: boolean };
    }>();
    expect(created.data).toMatchObject({ activeVersion: 1, enabled: false });

    const enabled = await call(
      ownerApp,
      `${personal}/${created.data.id}`,
      "PATCH",
      { enabled: true },
    );
    expect(enabled.status).toBe(200);
    await expect(enabled.json()).resolves.toMatchObject({
      data: { enabled: true, effectiveState: "effective" },
    });

    const secondBundle = makeBundle("Use the second reviewed version.");
    const secondPreview = await (
      await call(ownerApp, `${personal}/preview`, "POST", secondBundle)
    ).json<{ data: { integrity: string } }>();
    const invalidUpdate = await call(
      ownerApp,
      `${personal}/${created.data.id}/versions`,
      "POST",
      {
        bundle: secondBundle,
        reviewedIntegrity: firstPreview.data.integrity,
        activate: true,
      },
    );
    expect(invalidUpdate.status).toBe(409);
    const afterInvalid = await (await call(ownerApp, personal)).json<{
      data: {
        items: Array<{ id: string; activeVersion: number; versions: number[] }>;
      };
    }>();
    expect(afterInvalid.data.items[0]).toMatchObject({
      id: created.data.id,
      activeVersion: 1,
      versions: [1],
    });

    const published = await call(
      ownerApp,
      `${personal}/${created.data.id}/versions`,
      "POST",
      {
        bundle: secondBundle,
        reviewedIntegrity: secondPreview.data.integrity,
        activate: true,
      },
    );
    expect(published.status).toBe(201);
    await expect(published.json()).resolves.toMatchObject({
      data: { activeVersion: 2, versions: [2, 1] },
    });

    const exported = await call(
      ownerApp,
      `${personal}/${created.data.id}/export`,
    );
    expect(exported.status).toBe(200);
    await expect(exported.json()).resolves.toMatchObject({
      data: {
        integrity: secondPreview.data.integrity,
        source: { type: "browser-files" },
        files: expect.arrayContaining([
          expect.objectContaining({ path: "skill.json" }),
          expect.objectContaining({ path: "instructions.md" }),
          expect.objectContaining({ path: "resources/checklist.md" }),
        ]),
      },
    });

    const workspace = "/settings/workspaces/dx-team/skills";
    const workspacePreview = await (
      await call(ownerApp, `${workspace}/preview`, "POST", firstBundle)
    ).json<{ data: { integrity: string } }>();
    expect(
      (
        await call(ownerApp, workspace, "POST", {
          bundle: firstBundle,
          reviewedIntegrity: workspacePreview.data.integrity,
        })
      ).status,
    ).toBe(201);
    const memberApp = createSettingsApp(member);
    const memberList = await call(memberApp, workspace);
    expect(memberList.status).toBe(200);
    await expect(memberList.json()).resolves.toMatchObject({
      data: { canMutate: false, precedence: "workspace-over-personal" },
    });
    expect(
      (
        await call(memberApp, workspace, "POST", {
          bundle: firstBundle,
          reviewedIntegrity: workspacePreview.data.integrity,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await call(ownerApp, `${workspace}/policy`, "PATCH", {
          allowPersonalSkills: false,
        })
      ).status,
    ).toBe(200);
    expect(
      (
        await call(
          createSettingsApp(outsider),
          "/settings/workspaces/dx-team/skills",
        )
      ).status,
    ).toBe(403);
  });

  it("returns typed field errors for malformed workspace slugs", async () => {
    const response = await createSettingsApp(owner).request(
      "/settings/workspaces/not%20valid",
      {},
      { DB: env.DB },
    );
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toMatchObject({
      status: "error",
      data: {
        code: "INVALID_WORKSPACE_PROFILE",
        fieldErrors: [
          {
            field: "workspaceSlug",
            message: "Use a valid workspace short name.",
          },
        ],
      },
    });
  });
});
