import { afterEach, describe, expect, it, vi } from "vitest";
import { beginPersonalGitHubAuthorization } from "./integration-mutations.js";

const timestamp = "2026-08-22T00:00:00.000Z";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub integration requests", () => {
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

    await beginPersonalGitHubAuthorization("/projects?tab=recent#github");

    expect(fetch.mock.calls[0]?.[0]).toBe(
      "/v1/integrations/github/personal/authorize?return_to=%2Fprojects%3Ftab%3Drecent%23github",
    );
  });
});
