import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../testing/bindings.js";
import {
  preferredSigningBackend,
  signingBackendCapabilities,
  signingBackends,
} from "./backend.js";

describe("signing backend capabilities", () => {
  it("keeps runner agents and hardware unavailable on Cloudflare/E2B", async () => {
    const capabilities = await Effect.runPromise(
      signingBackendCapabilities({
        DB: {} as D1Database,
        DX_MANAGED_SSH_SIGNING_ENABLED: "true",
        DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
      }),
    );
    expect(signingBackends.map(({ kind }) => kind)).toEqual([
      "runner-ssh-agent",
      "runner-gpg-agent",
      "hardware",
      "managed-ssh-ed25519",
    ]);
    expect(capabilities.slice(0, 3)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          state: "unavailable",
          source: "runner",
          reason: "runner-not-supplied",
        }),
      ]),
    );
    expect(capabilities[3]).toMatchObject({
      backend: "managed-ssh-ed25519",
      state: "available",
      source: "deployment",
    });
  });

  it("requires both explicit operator enablement and encryption", async () => {
    await expect(
      Effect.runPromise(signingBackendCapabilities({ DB: {} as D1Database })),
    ).resolves.toContainEqual(
      expect.objectContaining({
        backend: "managed-ssh-ed25519",
        reason: "operator-disabled",
      }),
    );
    await expect(
      Effect.runPromise(
        signingBackendCapabilities({
          DB: {} as D1Database,
          DX_MANAGED_SSH_SIGNING_ENABLED: "true",
        }),
      ),
    ).resolves.toContainEqual(
      expect.objectContaining({
        backend: "managed-ssh-ed25519",
        reason: "encryption-unavailable",
      }),
    );
  });

  it("prefers delegated runner signing before the managed fallback", () => {
    expect(
      preferredSigningBackend([
        {
          backend: "managed-ssh-ed25519",
          state: "available",
          source: "deployment",
          reason: "available",
        },
        {
          backend: "runner-ssh-agent",
          state: "available",
          source: "runner",
          reason: "available",
        },
      ]),
    ).toMatchObject({ backend: "runner-ssh-agent", source: "runner" });
  });
});
