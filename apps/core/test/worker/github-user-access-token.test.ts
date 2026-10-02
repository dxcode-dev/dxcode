import { env } from "cloudflare:test";
import { Effect } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../src/settings/integrations/credential-vault.js";
import { readGitHubUserAccessToken } from "../../src/source-control/github/control-plane.js";
import { createTestBindings } from "../../src/testing/bindings.js";

const bindings = createTestBindings({ DB: env.DB }) as Bindings;
const now = "2026-09-30T00:00:00.000Z";

const put = (
  userId: string,
  purpose: "access-token" | "refresh-token",
  value: string,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      const vault = yield* IntegrationCredentialVault;
      return yield* vault.put(
        keyring,
        { scope: "personal", id: userId as never },
        purpose,
        value,
      );
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
  );

const authorize = async (userId: string, expiresInMs: number) => {
  await env.DB.prepare(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?)
  `)
    .bind(userId, userId, `${userId}@example.test`, now, now)
    .run();
  const [access, refresh] = await Promise.all([
    put(userId, "access-token", "ghu_current"),
    put(userId, "refresh-token", "ghr_current"),
  ]);
  await env.DB.prepare(`
    INSERT INTO github_user_authorization (
      id, user_id, provider_account_id, provider_account_login, status,
      access_token_reference_id, refresh_token_reference_id, expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, '42', 'octo', 'active', ?, ?, ?, NULL, ?, ?)
  `)
    .bind(
      `auth-${userId}`,
      userId,
      access.id,
      refresh.id,
      new Date(Date.now() + expiresInMs).toISOString(),
      now,
      now,
    )
    .run();
};

const refreshResponse = () =>
  Response.json({
    access_token: "ghu_refreshed",
    refresh_token: "ghr_refreshed",
    expires_in: 28_800,
    token_type: "bearer",
    scope: "",
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("GitHub user access token for native Git", () => {
  it("reuses a token with more than an hour left", async () => {
    await authorize("gh-token-fresh", 2 * 60 * 60 * 1_000);
    const fetcher = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetcher);
    await expect(
      readGitHubUserAccessToken(bindings, env.DB, "gh-token-fresh"),
    ).resolves.toBe("ghu_current");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("refreshes a token within its last hour, then reuses the new one", async () => {
    await authorize("gh-token-expiring", 30 * 60 * 1_000);
    const fetcher = vi.fn<typeof fetch>(async () => refreshResponse());
    vi.stubGlobal("fetch", fetcher);
    for (let attempt = 0; attempt < 2; attempt += 1)
      await expect(
        readGitHubUserAccessToken(bindings, env.DB, "gh-token-expiring"),
      ).resolves.toBe("ghu_refreshed");
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("keeps serving an unexpired token when refresh is unavailable", async () => {
    await authorize("gh-token-outage", 30 * 60 * 1_000);
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => new Response("", { status: 503 })),
    );
    await expect(
      readGitHubUserAccessToken(bindings, env.DB, "gh-token-outage"),
    ).resolves.toBe("ghu_current");
  });

  it("uses a concurrent refresh's token when its own refresh loses", async () => {
    await authorize("gh-token-race", 30 * 60 * 1_000);
    const winner = await put("gh-token-race", "access-token", "ghu_winner");
    vi.stubGlobal(
      "fetch",
      vi.fn<typeof fetch>(async () => {
        // Another request rotated the pair first; this refresh token is spent.
        await env.DB.prepare(
          "UPDATE github_user_authorization SET access_token_reference_id = ?, expires_at = ? WHERE user_id = ?",
        )
          .bind(
            winner.id,
            new Date(Date.now() + 8 * 60 * 60 * 1_000).toISOString(),
            "gh-token-race",
          )
          .run();
        return Response.json({ error: "bad_refresh_token" });
      }),
    );
    await expect(
      readGitHubUserAccessToken(bindings, env.DB, "gh-token-race"),
    ).resolves.toBe("ghu_winner");
  });
});
