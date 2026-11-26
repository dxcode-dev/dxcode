import {
  UpdatePersonalAccountEndpoint,
  UpdatePersonalAgentInstructionsEndpoint,
} from "@dx/api";
import type { PageCursor, ProjectId } from "@dx/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { dxClient, listThreads } from "./client.js";

const _timestamp = "2026-08-22T00:00:00.000Z";

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
});

describe("settings API client", () => {
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
      dxClient.call(UpdatePersonalAccountEndpoint, {
        body: { displayName: "Rowan", username: "claimed" },
      }),
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
      dxClient.call(UpdatePersonalAgentInstructionsEndpoint, {
        body: { instructions: "stale", expectedRevision: 3 },
      }),
    ).rejects.toMatchObject({
      status: 409,
      code: "AGENT_INSTRUCTIONS_REVISION_CONFLICT",
      currentRevision: 4,
      hasValidatedPayload: true,
    });
  });
});
