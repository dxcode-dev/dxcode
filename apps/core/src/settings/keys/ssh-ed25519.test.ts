import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import {
  canonicalizeSigningPublicKey,
  generateManagedSshKey,
} from "./ssh-ed25519.js";

const fixture =
  "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSUV2/JWiltQzaWHwdPQhth4lkUTjZI8+QknRW7h50P fixture-comment";

describe("SSH Ed25519 signing key material", () => {
  it("canonicalizes a deterministic public fixture and calculates the OpenSSH fingerprint", async () => {
    await expect(
      Effect.runPromise(canonicalizeSigningPublicKey(fixture)),
    ).resolves.toEqual({
      publicKey:
        "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAILSUV2/JWiltQzaWHwdPQhth4lkUTjZI8+QknRW7h50P",
      fingerprint: "SHA256:WicVbC2AWcGq2eITP9uHSQquHYqDcPilYx0xjbpX2AM",
    });
  });

  it("generates matching public-only metadata and an OpenSSH private key", async () => {
    const generated = await Effect.runPromise(generateManagedSshKey());
    await expect(
      Effect.runPromise(canonicalizeSigningPublicKey(generated.publicKey)),
    ).resolves.toEqual({
      publicKey: generated.publicKey,
      fingerprint: generated.fingerprint,
    });
    expect(generated.privateKey).toMatch(
      /^-----BEGIN OPENSSH PRIVATE KEY-----/,
    );
    expect(generated.publicKey).not.toContain("PRIVATE");
  });

  it("rejects non-canonical algorithms and malformed blobs", async () => {
    await expect(
      Effect.runPromise(canonicalizeSigningPublicKey("ssh-rsa AAAA")),
    ).rejects.toMatchObject({ _tag: "InvalidSshPublicKey" });
    await expect(
      Effect.runPromise(
        canonicalizeSigningPublicKey(
          "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIA== trailing\nsecond-line",
        ),
      ),
    ).rejects.toMatchObject({ _tag: "InvalidSshPublicKey" });
  });
});
