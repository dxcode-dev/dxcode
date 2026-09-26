import { IntegrationCredentialConfigReference, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";

describe("IntegrationCredentialVaultD1", () => {
  it("round-trips only an opaque encrypted reference bound to its owner and purpose", async () => {
    const owner = {
      scope: "personal" as const,
      id: Schema.decodeUnknownSync(UserId)("credential-vault-owner"),
    };
    const plaintext = "deterministic-fake-oauth-token";
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring({
        DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
      }),
    );
    const reference = await Effect.runPromise(
      Effect.gen(function* () {
        const vault = yield* IntegrationCredentialVault;
        return yield* vault.put(keyring, owner, "access-token", plaintext);
      }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
    );
    expect(Schema.is(IntegrationCredentialConfigReference)(reference)).toBe(
      true,
    );
    const row = await env.DB.prepare(
      "SELECT * FROM integration_credential WHERE id = ?",
    )
      .bind(reference.id)
      .first<Record<string, unknown>>();
    expect(row).not.toBeNull();
    expect(JSON.stringify(row)).not.toContain(plaintext);
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          const vault = yield* IntegrationCredentialVault;
          return yield* vault.read(keyring, owner, "access-token", reference);
        }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
      ),
    ).resolves.toBe(plaintext);
  });
});
