import type { ProjectId, ThreadTitle } from "@dx/domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createThread } from "./thread-mutations.js";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("thread API", () => {
  it("surfaces validated source-authorization failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
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
        ),
      ),
    );

    await expect(
      createThread(
        "prj_00000000-0000-4000-8000-000000000001" as ProjectId,
        "Source thread" as ThreadTitle,
      ),
    ).rejects.toMatchObject({
      status: 409,
      code: "SOURCE_AUTHORIZATION_DENIED",
      message:
        "Source access requires action before this operation can continue.",
      hasValidatedPayload: true,
    });
  });

  it("surfaces validated projectless admission failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof globalThis.fetch>().mockResolvedValue(
        Response.json(
          {
            status: "error",
            data: {
              code: "PROJECT_CREATION_FORBIDDEN",
              message: "Workspace policy does not allow this project.",
              requestId: "request-2",
            },
          },
          { status: 403 },
        ),
      ),
    );

    await expect(
      createThread(undefined, "Projectless thread" as ThreadTitle),
    ).rejects.toMatchObject({
      status: 403,
      code: "PROJECT_CREATION_FORBIDDEN",
      message: "Workspace policy does not allow this project.",
      hasValidatedPayload: true,
    });
  });
});
