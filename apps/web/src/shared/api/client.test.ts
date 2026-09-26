import { PersonalAgentInstructionsDataSchema } from "@dx/api";
import type { PageCursor, ProjectId, WorkspaceSlug } from "@dx/domain";
import { Schema } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ApiError,
  beginGitHubAuthorization,
  createProject,
  createWorkspace,
  disconnectGitHub,
  getPersonalAccount,
  getPersonalAgentInstructions,
  getSettingsContext,
  listMcpServers,
  listProjects,
  listThreads,
  pollPersonalModelSubscriptionAuthorization,
  resetPersonalAgentInstructions,
  updateMcpWorkspacePolicy,
  updatePersonalAccount,
  updatePersonalAppearance,
  updatePersonalAgentInstructions,
  updateWorkspaceProfile,
} from "./client.js";

const timestamp = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paginated API client", () => {
  it("returns the project cursor and requests the next page", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: {
            items: [
              {
                id: "prj_00000000-0000-4000-8000-000000000001",
                name: "First",
                configuration: {
                  shipAction: "ship",
                  commitAuthor: {
                    preference: "dx",
                    name: "dx",
                    email: "noreply@dx.local",
                  },
                  signingPreference: "disabled",
                  runnerProfileId: "e2b-default",
                  publicCodeEnabled: false,
                },
                revision: 0,
                createdAt: timestamp,
                updatedAt: timestamp,
              },
            ],
            nextCursor: "bmV4dC1wcm9qZWN0LXBhZ2U",
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: { items: [] } }),
      );
    vi.stubGlobal("fetch", fetch);

    const first = await listProjects();
    expect(first.nextCursor).toBe("bmV4dC1wcm9qZWN0LXBhZ2U");
    await listProjects(first.nextCursor);
    expect(fetch.mock.calls[1]?.[0]).toBe(
      "/v1/projects?limit=100&cursor=bmV4dC1wcm9qZWN0LXBhZ2U",
    );
  });

  it("preserves project filtering when loading another thread page", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValue(
        Response.json({ status: "success", data: { items: [] } }),
      );
    vi.stubGlobal("fetch", fetch);

    await listThreads(
      "prj_00000000-0000-4000-8000-000000000001" as ProjectId,
      "bmV4dC10aHJlYWQtcGFnZQ" as PageCursor,
    );
    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/threads?limit=100&projectId=prj_00000000-0000-4000-8000-000000000001&cursor=bmV4dC10aHJlYWQtcGFnZQ",
    );
  });

  it("does not expose messages from undecoded error responses", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: { code: "PERSISTENCE_UNAVAILABLE", message: "Try later." },
          },
          { status: 503 },
        ),
      ),
    );

    await expect(listProjects()).rejects.toMatchObject({
      status: 503,
      message: "Request failed.",
      hasValidatedPayload: false,
    });
  });
});

describe("project and thread API errors", () => {
  it("surfaces validated source-authorization failures", async () => {
    const sourceDenied = Response.json(
      {
        status: "error",
        data: {
          code: "SOURCE_AUTHORIZATION_DENIED",
          message:
            "Source access requires action before this operation can continue.",
          requestId: "request-1",
          reason: "grant-disconnected",
          action: "reconnect",
        },
      },
      { status: 409 },
    );
    vi.stubGlobal(
      "fetch",
      vi
        .fn<typeof globalThis.fetch>()
        .mockResolvedValueOnce(sourceDenied)
        .mockResolvedValueOnce(sourceDenied.clone()),
    );

    await expect(
      createProject({ name: "source-project", source: { kind: "scratch" } }),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_AUTHORIZATION_DENIED",
      message:
        "Source access requires action before this operation can continue.",
      hasValidatedPayload: true,
    });
  });

  it("surfaces validated project-name conflicts", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "PROJECT_NAME_CONFLICT",
              message: "A project with this name already exists.",
              requestId: "request-1",
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(
      createProject({ name: "duplicate", source: { kind: "scratch" } }),
    ).rejects.toMatchObject({
      status: 409,
      code: "PROJECT_NAME_CONFLICT",
      message: "A project with this name already exists.",
      hasValidatedPayload: true,
    });
  });
});

describe("settings API client", () => {
  it("encodes the DX return target in the GitHub authorization request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: {
          authorizationUrl: "https://github.com/login/oauth/authorize",
          expiresAt: timestamp,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await beginGitHubAuthorization("/projects?tab=recent#github");

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/integrations/github/personal/authorize?return_to=%2Fprojects%3Ftab%3Drecent%23github",
    );
  });

  it("disconnects GitHub with one server-owned lifecycle request", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: {
          grantId: "grant-1",
          localAccessStopped: true,
          installationUninstalled: true,
        },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await disconnectGitHub("grant-1");

    expect(fetch).toHaveBeenCalledTimes(1);
    expect(fetch).toHaveBeenCalledWith(
      "/v1/integrations/github/personal/grants/grant-1",
      expect.objectContaining({ method: "DELETE" }),
    );
  });

  it("preserves typed personal subscription failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "PERSONAL_MODEL_SUBSCRIPTION_BROWSER_SESSION_REQUIRED",
              message:
                "A browser session is required to change a personal model subscription.",
              requestId: "subscription-request",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      pollPersonalModelSubscriptionAuthorization("authorization-id"),
    ).rejects.toMatchObject({
      status: 403,
      code: "PERSONAL_MODEL_SUBSCRIPTION_BROWSER_SESSION_REQUIRED",
      message:
        "A browser session is required to change a personal model subscription.",
      hasValidatedPayload: true,
    });
  });

  it("uses exact personal and workspace MCP server paths", async () => {
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { items: [], canMutate: true },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: {
            items: [],
            canMutate: true,
            allowPersonalServers: true,
          },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { allowPersonalServers: false },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await listMcpServers({ scope: "personal" });
    const workspace = {
      scope: "workspace" as const,
      workspaceSlug: "dx-team" as WorkspaceSlug,
    };
    await listMcpServers(workspace);
    await updateMcpWorkspacePolicy(workspace, false);

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/settings/personal/mcp-servers",
      "/v1/settings/workspaces/dx-team/mcp-servers",
      "/v1/settings/workspaces/dx-team/mcp-servers/policy",
    ]);
    expect(fetch.mock.calls[2]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({ allowPersonalServers: false }),
    });
  });

  it("requests exact personal and workspace scope paths", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      Response.json({
        status: "success",
        data: { activeScope: "personal" },
      }),
    );
    vi.stubGlobal("fetch", fetch);

    await getSettingsContext({ scope: "personal" });
    fetch.mockResolvedValueOnce(
      Response.json({
        status: "success",
        data: {
          id: "workspace-id",
          displayName: "DX Team",
          shortName: "dx-team",
          lifecycleState: "active",
          revision: 0,
          role: "owner",
        },
      }),
    );
    await getSettingsContext({
      scope: "workspace",
      workspaceSlug: "dx-team" as WorkspaceSlug,
    });

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/settings/personal",
      "/v1/settings/workspaces/dx-team",
    ]);
  });

  it("loads and updates the current user's personal account", async () => {
    const account = {
      displayName: "Rowan",
      username: "rowan",
      email: "rowan@example.com",
      emailVerified: true,
      identityAuthority: "cloudflare-access",
      threadCount: 12,
      appearance: "dark",
      palette: "daydream",
      terminalTheme: "github",
    } as const;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: account }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { ...account, username: "rowan-updated" },
        }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: { ...account, appearance: "light", palette: "deadpan" },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(getPersonalAccount()).resolves.toEqual(account);
    await expect(
      updatePersonalAccount({
        displayName: "Rowan",
        username: "rowan-updated",
      }),
    ).resolves.toMatchObject({ username: "rowan-updated" });
    await expect(
      updatePersonalAppearance({
        appearance: "light",
        palette: "deadpan",
        terminalTheme: "gruvbox",
      }),
    ).resolves.toMatchObject({ appearance: "light", palette: "deadpan" });
    expect(fetch.mock.calls[0]?.[0]).toBe("/v1/settings/personal/account");
    expect(fetch.mock.calls[1]?.[0]).toBe("/v1/settings/personal/account");
    expect(fetch.mock.calls[1]?.[1]).toMatchObject({
      method: "PATCH",
      body: JSON.stringify({
        displayName: "Rowan",
        username: "rowan-updated",
      }),
    });
    expect(fetch.mock.calls[2]).toEqual([
      "/v1/settings/personal/account/appearance",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          appearance: "light",
          palette: "deadpan",
          terminalTheme: "gruvbox",
        }),
      }),
    ]);
  });

  it("creates and updates the one workspace through exact dx routes", async () => {
    const workspace = {
      id: "stable-workspace-id",
      displayName: "DX Team",
      shortName: "dx-team",
      lifecycleState: "active",
      revision: 0,
      role: "owner",
    } as const;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: workspace }),
      )
      .mockResolvedValueOnce(
        Response.json({
          status: "success",
          data: {
            ...workspace,
            displayName: "Renamed Team",
            shortName: "renamed-team",
          },
        }),
      );
    vi.stubGlobal("fetch", fetch);

    await expect(
      createWorkspace({ displayName: "DX Team", shortName: "dx-team" }),
    ).resolves.toEqual(workspace);
    await expect(
      updateWorkspaceProfile("dx-team" as WorkspaceSlug, {
        displayName: "Renamed Team",
        shortName: "renamed-team",
        expectedRevision: 0,
      }),
    ).resolves.toMatchObject({
      id: "stable-workspace-id",
      shortName: "renamed-team",
    });
    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/settings/workspaces",
      "/v1/settings/workspaces/dx-team",
    ]);
    expect(fetch.mock.calls.map(([, init]) => init?.method)).toEqual([
      "POST",
      "PATCH",
    ]);
    expect(fetch.mock.calls[1]?.[1]?.body).toBe(
      JSON.stringify({
        displayName: "Renamed Team",
        shortName: "renamed-team",
        expectedRevision: 0,
      }),
    );
  });

  it("preserves typed username conflict feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "USERNAME_UNAVAILABLE",
              message: "That username is already in use.",
              requestId: "request-conflict",
              fieldErrors: [
                {
                  field: "username",
                  message: "Choose a different username.",
                },
              ],
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(
      updatePersonalAccount({ displayName: "Rowan", username: "claimed" }),
    ).rejects.toMatchObject({
      status: 409,
      code: "USERNAME_UNAVAILABLE",
      fieldErrors: [{ field: "username" }],
      hasValidatedPayload: true,
    });
  });

  it("loads, saves, and resets revisioned personal agent instructions", async () => {
    const initial = {
      instructions: "",
      revision: 0,
      version: 1,
      updatedAt: timestamp,
    } as const;
    const saved = {
      ...initial,
      instructions: "Prefer targeted checks.",
      revision: 1,
    } as const;
    const reset = { ...initial, revision: 2 } as const;
    const fetch = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(
        Response.json({ status: "success", data: initial }),
      )
      .mockResolvedValueOnce(Response.json({ status: "success", data: saved }))
      .mockResolvedValueOnce(Response.json({ status: "success", data: reset }));
    vi.stubGlobal("fetch", fetch);

    await expect(getPersonalAgentInstructions()).resolves.toEqual(
      Schema.decodeUnknownSync(PersonalAgentInstructionsDataSchema)(initial),
    );
    await expect(
      updatePersonalAgentInstructions({
        instructions: saved.instructions,
        expectedRevision: 0,
      }),
    ).resolves.toEqual(
      Schema.decodeUnknownSync(PersonalAgentInstructionsDataSchema)(saved),
    );
    await expect(resetPersonalAgentInstructions(1)).resolves.toEqual(
      Schema.decodeUnknownSync(PersonalAgentInstructionsDataSchema)(reset),
    );

    expect(fetch.mock.calls.map(([path]) => path)).toEqual([
      "/v1/settings/personal/agent-instructions",
      "/v1/settings/personal/agent-instructions",
      "/v1/settings/personal/agent-instructions",
    ]);
    expect(fetch.mock.calls.slice(1).map(([, init]) => init?.body)).toEqual([
      JSON.stringify({
        instructions: "Prefer targeted checks.",
        expectedRevision: 0,
      }),
      JSON.stringify({ instructions: "", expectedRevision: 1 }),
    ]);
  });

  it("preserves typed instruction revision conflicts for reload feedback", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
              message:
                "Agent instructions changed in another session. Reload before saving.",
              requestId: "request-conflict",
              currentRevision: 4,
            },
          },
          { status: 409 },
        ),
      ),
    );

    await expect(
      updatePersonalAgentInstructions({
        instructions: "stale",
        expectedRevision: 3,
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
      currentRevision: 4,
      hasValidatedPayload: true,
    });
  });

  it("preserves typed settings error codes and field errors", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "INVALID_SETTINGS_SCOPE",
              message: "Settings scope validation failed.",
              requestId: "request-1",
              fieldErrors: [
                {
                  field: "workspaceSlug",
                  message: "Use a valid workspace slug.",
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );

    const error = await getSettingsContext({
      scope: "workspace",
      workspaceSlug: "valid-slug" as WorkspaceSlug,
    }).catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      status: 400,
      code: "INVALID_SETTINGS_SCOPE",
      fieldErrors: [{ field: "workspaceSlug" }],
      hasValidatedPayload: true,
    });
  });
});
