import { env } from "cloudflare:test";
import { Effect } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  GitHubRepository,
  GitHubRepositoryD1,
} from "../../src/source-control/github/repository-d1.js";

const now = "2026-08-25T12:00:00.000Z";
const run = <A, E>(effect: Effect.Effect<A, E, GitHubRepository>) =>
  Effect.runPromise(effect.pipe(Effect.provide(GitHubRepositoryD1(env.DB))));

const insertUser = (id: string) =>
  env.DB.prepare(`
    INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt)
    VALUES (?, ?, ?, 1, ?, ?)
  `)
    .bind(id, id, `${id}@example.test`, now, now)
    .run();

const saveInstallation = (installationId: string, accountId: string) =>
  run(
    Effect.gen(function* () {
      const repository = yield* GitHubRepository;
      yield* repository.saveInstallation({
        installationId,
        appId: "12345",
        providerAccountId: accountId,
        providerAccountType: "organization",
        providerAccountLogin: `account-${accountId}`,
        repositorySelection: "selected",
        status: "active",
        permissionsVersion: 1,
        now,
      });
    }),
  );

beforeEach(async () => {
  await Promise.all([insertUser("github-user-a"), insertUser("github-user-b")]);
});

describe("GitHub normalized persistence", () => {
  it("refreshes canonical authorization data over a migrated legacy identity", async () => {
    await env.DB.prepare(`
      INSERT INTO github_user_authorization (
        id, user_id, provider_account_id, provider_account_login, status,
        created_at, updated_at
      ) VALUES ('legacy:connection', 'github-user-a', '901', 'old-login',
                'reauthorization-required', ?, ?)
    `)
      .bind(now, now)
      .run();
    await run(
      Effect.gen(function* () {
        const repository = yield* GitHubRepository;
        yield* repository.saveUserAuthorization({
          id: "ghu_github-user-a_901",
          userId: "github-user-a",
          providerAccountId: "901",
          providerAccountLogin: "new-login",
          status: "active",
          accessTokenReferenceId: undefined,
          refreshTokenReferenceId: undefined,
          expiresAt: undefined,
          refreshExpiresAt: undefined,
          now,
        });
      }),
    );
    expect(
      await env.DB.prepare(`
        SELECT id, provider_account_login, status
          FROM github_user_authorization
         WHERE user_id = 'github-user-a' AND provider_account_id = '901'
      `).first(),
    ).toEqual({
      id: "legacy:connection",
      provider_account_login: "new-login",
      status: "active",
    });
  });

  it("refreshes immutable installation account identity fields", async () => {
    await saveInstallation("9001", "old-account");
    await run(
      Effect.gen(function* () {
        const repository = yield* GitHubRepository;
        yield* repository.saveInstallation({
          installationId: "9001",
          appId: "67890",
          providerAccountId: "new-account",
          providerAccountType: "user",
          providerAccountLogin: "new-login",
          repositorySelection: "all",
          status: "active",
          permissionsVersion: 2,
          now,
        });
      }),
    );
    expect(
      await env.DB.prepare(`
        SELECT app_id, provider_account_id, provider_account_type
          FROM github_installation WHERE installation_id = '9001'
      `).first(),
    ).toEqual({
      app_id: "67890",
      provider_account_id: "new-account",
      provider_account_type: "user",
    });
  });

  it("moves a legacy OAuth-only connection to reauthorization without inventing an installation", async () => {
    await env.DB.prepare(`
      INSERT INTO integration_connection (
        id, owner_scope, owner_id, provider, status, health,
        provider_account_id, provider_account_login, granted_scopes,
        revocation_status, created_at, updated_at
      ) VALUES (
        'legacy-connection', 'personal', 'github-user-a', 'github',
        'connected', 'healthy', 'legacy-account', 'mutable-login', '[]',
        'not-requested', ?, ?
      )
    `)
      .bind(now, now)
      .run();
    await env.DB.batch([
      env.DB.prepare(`
        INSERT INTO github_user_authorization (
          id, user_id, provider_account_id, provider_account_login, status,
          access_token_reference_id, refresh_token_reference_id, expires_at,
          refresh_expires_at, created_at, updated_at
        )
        SELECT 'legacy:' || id, owner_id, provider_account_id,
               provider_account_login, 'reauthorization-required',
               access_token_reference_id, refresh_token_reference_id,
               expires_at, refresh_expires_at, created_at, updated_at
          FROM integration_connection
         WHERE provider = 'github' AND owner_scope = 'personal'
      `),
      env.DB.prepare(`
        UPDATE integration_connection
           SET status = 'needs-reauthorization', health = 'expired'
         WHERE provider = 'github' AND status = 'connected'
      `),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT status FROM integration_connection WHERE id = 'legacy-connection'",
      ).first(),
    ).toEqual({ status: "needs-reauthorization" });
    expect(
      await env.DB.prepare(
        "SELECT status FROM github_user_authorization WHERE id = 'legacy:legacy-connection'",
      ).first(),
    ).toEqual({ status: "reauthorization-required" });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM github_installation",
      ).first<number>("count"),
    ).toBe(0);
  });

  it("keeps installation entitlements isolated", async () => {
    await Promise.all([
      saveInstallation("1001", "501"),
      saveInstallation("1002", "502"),
    ]);
    await run(
      Effect.gen(function* () {
        const repository = yield* GitHubRepository;
        yield* repository.bindOwner({
          id: "grant-a",
          ownerScope: "personal",
          ownerId: "github-user-a",
          installationId: "1001",
          createdByUserId: "github-user-a",
          now,
        });
        yield* repository.bindOwner({
          id: "grant-b",
          ownerScope: "personal",
          ownerId: "github-user-b",
          installationId: "1002",
          createdByUserId: "github-user-b",
          now,
        });
        yield* repository.replaceEntitlements(
          "1001",
          [
            {
              providerRepositoryId: "7001",
              fullName: "owner-a/repository",
              webUrl: "https://github.com/owner-a/repository",
              visibility: "private",
            },
          ],
          now,
        );
      }),
    );
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM github_installation_repository WHERE installation_id = '1001' AND entitled = 1",
      ).first<number>("count"),
    ).toBe(1);
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM github_installation_repository WHERE installation_id = '1002' AND entitled = 1",
      ).first<number>("count"),
    ).toBe(0);
  });

  it("advances isolated authorization epochs", async () => {
    await saveInstallation("2001", "601");
    await run(
      Effect.gen(function* () {
        const repository = yield* GitHubRepository;
        yield* repository.bindOwner({
          id: "grant-c",
          ownerScope: "personal",
          ownerId: "github-user-a",
          installationId: "2001",
          createdByUserId: "github-user-a",
          now,
        });
        expect(
          yield* repository.incrementAuthorizationEpoch(
            "owner-grant",
            "grant-c",
            now,
          ),
        ).toBe(2);
        expect(
          yield* repository.incrementAuthorizationEpoch(
            "owner-grant",
            "grant-c",
            now,
          ),
        ).toBe(3);
        expect(
          yield* repository.incrementAuthorizationEpoch(
            "installation",
            "2001",
            now,
          ),
        ).toBe(2);
      }),
    );
  });

  it("bounds setup and webhook delivery state and deduplicates delivery IDs", async () => {
    await expect(
      env.DB.prepare(`
        INSERT INTO github_setup_transaction (
          id, state_hash, actor_user_id, browser_session_id, owner_scope,
          owner_id, status, verifier_reference_id, expires_at, created_at
        ) VALUES ('setup-a', ?, 'github-user-a', ?, 'personal',
                  'github-user-a', 'pending', 'missing-reference', ?, ?)
      `)
        .bind("a".repeat(64), "x".repeat(257), now, now)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare(`
        INSERT INTO github_webhook_delivery (
          delivery_id, event, action, payload_sha256, state, attempts,
          received_at, updated_at, expires_at
        ) VALUES ('delivery-a', 'repository', 'renamed', ?, 'received', 17, ?, ?, ?)
      `)
        .bind("a".repeat(64), now, now, now)
        .run(),
    ).rejects.toBeDefined();
    await env.DB.prepare(`
      INSERT INTO github_webhook_delivery (
        delivery_id, event, action, payload_sha256, state, attempts,
        received_at, updated_at, expires_at
      ) VALUES ('delivery-a', 'repository', 'renamed', ?, 'received', 0, ?, ?, ?)
    `)
      .bind("a".repeat(64), now, now, now)
      .run();
    await expect(
      env.DB.prepare(`
        INSERT INTO github_webhook_delivery (
          delivery_id, event, action, payload_sha256, state, attempts,
          received_at, updated_at, expires_at
        ) VALUES ('delivery-a', 'repository', 'renamed', ?, 'received', 0, ?, ?, ?)
      `)
        .bind("b".repeat(64), now, now, now)
        .run(),
    ).rejects.toBeDefined();
  });
});
