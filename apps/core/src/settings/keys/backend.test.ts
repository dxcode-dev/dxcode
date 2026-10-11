import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { signingBackendCapabilities } from "./backend.js";

describe("signing backend capabilities", () => {
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
});
