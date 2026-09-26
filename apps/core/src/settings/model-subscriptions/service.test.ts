import {
  BeginPersonalModelSubscriptionAuthorizationResponseSchema,
  ListPersonalModelSubscriptionsResponseSchema,
} from "@dx/api";
import { Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import type { ConfigEncryptionKeyring } from "../config-encryption.js";
import { createGitHubCopilotProvider } from "./github-copilot/provider.js";
import type { PersonalModelSubscriptionRepositoryD1 } from "./repository-d1.js";
import { PersonalModelSubscriptionService } from "./service.js";

const clock = Date.parse("2026-08-30T03:34:35.000Z");

const keyring = async (): Promise<ConfigEncryptionKeyring> => ({
  activeVersion: 1,
  keys: new Map([
    [
      1,
      await crypto.subtle.importKey(
        "raw",
        new Uint8Array(32).fill(1),
        { name: "AES-GCM" },
        false,
        ["encrypt", "decrypt"],
      ),
    ],
  ]),
});

describe("PersonalModelSubscriptionService", () => {
  it("returns an authorization that the HTTP schema can encode", async () => {
    const repository = {
      replaceAuthorization: vi.fn().mockResolvedValue(undefined),
    } as unknown as PersonalModelSubscriptionRepositoryD1;
    const provider = createGitHubCopilotProvider({
      clientId: "dx-owned-client",
      clock: () => clock,
      fetch: vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            device_code: "secret-device-code",
            user_code: "ABCD-1234",
            verification_uri: "https://github.com/login/device",
            expires_in: 900,
            interval: 5,
          }),
        ),
      ),
    });
    const service = new PersonalModelSubscriptionService(
      repository,
      provider,
      await keyring(),
      () => clock,
    );

    const authorization = await service.begin(
      "user-1",
      "session-1",
      "github-copilot",
    );
    const encoded = Schema.encodeUnknownSync(
      BeginPersonalModelSubscriptionAuthorizationResponseSchema,
    )({ status: "success", data: authorization });

    expect(encoded.data).toMatchObject({
      expiresAt: "2026-08-30T03:49:35.000Z",
      nextPollAt: "2026-08-30T03:34:40.000Z",
    });
  });

  it("returns connections that the HTTP schema can encode", async () => {
    const repository = {
      list: vi.fn().mockResolvedValue([
        {
          id: "connection-1",
          ownerUserId: "user-1",
          provider: "github-copilot",
          providerAccountId: "42",
          providerAccountLogin: "octocat",
          status: "connected",
          credentialEnvelope: null,
          credentialRevision: 1,
          modelIds: ["gpt-5-mini"],
          catalogRevision: "test:catalog",
          observedAt: "2026-08-30T03:30:00.000Z",
          refreshAfter: "2026-08-30T04:30:00.000Z",
          createdAt: "2026-08-30T03:30:00.000Z",
          connectedAt: "2026-08-30T03:30:00.000Z",
          updatedAt: "2026-08-30T03:30:00.000Z",
        },
      ]),
    } as unknown as PersonalModelSubscriptionRepositoryD1;
    const service = new PersonalModelSubscriptionService(
      repository,
      createGitHubCopilotProvider({ clientId: "dx-owned-client" }),
      await keyring(),
    );

    const connections = await service.list("user-1");
    const encoded = Schema.encodeUnknownSync(
      ListPersonalModelSubscriptionsResponseSchema,
    )({ status: "success", data: { connections } });

    expect(encoded.data.connections[0]).toMatchObject({
      observedAt: "2026-08-30T03:30:00.000Z",
      refreshAfter: "2026-08-30T04:30:00.000Z",
      connectedAt: "2026-08-30T03:30:00.000Z",
      updatedAt: "2026-08-30T03:30:00.000Z",
    });
  });
});
