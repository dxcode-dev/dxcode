import type { PageCursor, ProjectId } from "@dx/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  beginGitHubAuthorization,
  createProject,
  listProjects,
  listThreads,
  updatePersonalAccount,
  updatePersonalAgentInstructions,
} from "./client.js";

const timestamp = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("paginated API client", () => {
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
});
