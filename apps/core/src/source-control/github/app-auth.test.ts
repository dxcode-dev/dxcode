import { generateKeyPairSync } from "node:crypto";
import { decodeJwt } from "jose";
import { describe, expect, it } from "vitest";
import {
  createGitHubAppJwt,
  encodeInstallationTokenRequest,
} from "./app-auth.js";

describe("GitHub App authentication encoding", () => {
  it("bounds JWT issue and expiry around an injected clock", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const now = new Date("2026-08-25T12:00:00.000Z");
    const jwt = await createGitHubAppJwt({
      appId: "12345",
      privateKeyPem: privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      now,
    });
    const payload = decodeJwt(jwt);
    const seconds = Math.floor(now.getTime() / 1_000);
    expect(payload).toMatchObject({
      iss: "12345",
      iat: seconds - 60,
      exp: seconds + 540,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);

    await expect(
      createGitHubAppJwt({
        appId: "12345",
        privateKeyPem: privateKey
          .export({ type: "pkcs1", format: "pem" })
          .toString(),
        now,
      }),
    ).resolves.toMatch(/^[^.]+\.[^.]+\.[^.]+$/);
  });

  it("encodes exactly one numeric repository and the requested permission subset", () => {
    expect(
      encodeInstallationTokenRequest({
        repositoryId: "9007199254740991",
        permissions: { contents: "write", workflows: "write" },
      }),
    ).toEqual({
      repository_ids: [9_007_199_254_740_991],
      permissions: { contents: "write", workflows: "write" },
    });
    expect(() =>
      encodeInstallationTokenRequest({
        repositoryId: "1,2",
        permissions: { contents: "write" },
      }),
    ).toThrow();
  });
});
