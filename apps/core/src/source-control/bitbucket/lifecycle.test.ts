import { readFileSync } from "node:fs";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { integrationCredentialReferenceFor } from "@dx/domain";
import { Effect, Redacted } from "effect";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import manifest from "../../../migration-manifest.json" with { type: "json" };
import type { AppEnv } from "../../http/types.js";
import { loadConfigEncryptionKeyring } from "../../settings/config-encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
} from "../../settings/integrations/credential-vault.js";
import {
  createBitbucketControlPlane,
  disconnectBitbucket,
  readBitbucketConnection,
  readBitbucketThreadAuthority,
} from "./control-plane.js";
import { bitbucketGitGatewayRoutes } from "./git-gateway.js";
import { BitbucketProviderError } from "./provider-http.js";
import { bitbucketRuntimeBroker } from "./runtime.js";

const userId = "user-one";
const workspaceId = "{11111111-1111-4111-8111-111111111111}";
const repositoryId = "{22222222-2222-4222-8222-222222222222}";
const threadId = "thr_11111111-1111-4111-8111-111111111111";
const projectId = "prj_11111111-1111-4111-8111-111111111111";
const bindings = {
  DX_RUNTIME_MODE: "deployed",
  DX_ENV: "test",
  DX_AUTH_URL: "https://dx.example",
  DX_CONFIG_ENCRYPTION_KEYS: JSON.stringify({
    activeVersion: 1,
    keys: { 1: btoa("01234567890123456789012345678901") },
  }),
  DX_INTEGRATION_BITBUCKET_OAUTH: JSON.stringify({
    version: 1,
    clientId: "client",
    clientSecret: "client-secret",
    callbackUrl: "https://dx.example/v1/integrations/bitbucket/oauth/callback",
  }),
};
const repository = {
  uuid: repositoryId,
  workspace: { uuid: workspaceId },
  full_name: "space/repo",
  scm: "git",
  is_private: true,
  mainbranch: { name: "main" },
  links: {
    html: { href: "https://bitbucket.org/space/repo" },
    clone: [
      { name: "https", href: "https://user@bitbucket.org/space/repo.git" },
    ],
  },
};
const databases: DatabaseSync[] = [];
afterEach(() => {
  vi.unstubAllGlobals();
  for (const db of databases.splice(0)) db.close();
});

const database = () => {
  const sqlite = new DatabaseSync(":memory:");
  databases.push(sqlite);
  sqlite.exec("PRAGMA foreign_keys = ON");
  for (const migration of manifest.d1)
    sqlite.exec(
      readFileSync(
        new URL(`../../../migrations/${migration.filename}`, import.meta.url),
        "utf8",
      ),
    );
  sqlite
    .prepare(
      'INSERT INTO "user" (id,name,email,emailVerified,createdAt,updatedAt) VALUES (?,?,?,1,?,?)',
    )
    .run(
      userId,
      "User",
      "one@example.com",
      new Date().toISOString(),
      new Date().toISOString(),
    );
  const statement = (sql: string, values: SQLInputValue[] = []) => ({
    bind: (...parameters: SQLInputValue[]) => statement(sql, parameters),
    first: async (column?: string) => {
      const value = sqlite.prepare(sql).get(...values);
      return column ? (value?.[column] ?? null) : (value ?? null);
    },
    all: async () => ({
      success: true,
      results: sqlite.prepare(sql).all(...values),
      meta: { changes: 0 },
    }),
    run: async () => {
      const result = sqlite.prepare(sql).run(...values);
      return {
        success: true,
        results: [],
        meta: {
          changes: Number(result.changes),
          last_row_id: Number(result.lastInsertRowid),
        },
      };
    },
  });
  const db = {
    prepare: statement,
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      sqlite.exec("BEGIN");
      try {
        const results = [];
        for (const item of statements) results.push(await item.run());
        sqlite.exec("COMMIT");
        return results;
      } catch (cause) {
        sqlite.exec("ROLLBACK");
        throw cause;
      }
    },
  } as unknown as D1Database;
  return { db, sqlite };
};
const fixture = async () => {
  const { db, sqlite } = database();
  let generation = 0;
  const fetcher = vi.fn<typeof fetch>(async (url) => {
    if (String(url).includes("/access_token"))
      return Response.json({
        access_token: `access-secret-${++generation}`,
        refresh_token: `refresh-secret-${generation}`,
        expires_in: 3600,
        scopes: "account repository:write pullrequest:write",
      });
    if (String(url).endsWith("/2.0/user"))
      return Response.json({ uuid: workspaceId, nickname: "person" });
    if (String(url).includes("/commits/"))
      return Response.json({ values: [{ hash: "a".repeat(40) }] });
    if (String(url).startsWith("https://api.bitbucket.org/2.0/repositories/"))
      return Response.json(repository);
    return new Response("unknown", { status: 404 });
  });
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(bindings),
  );
  const vault = await Effect.runPromise(
    Effect.gen(function* () {
      return yield* IntegrationCredentialVault;
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(db))),
  );
  const service = createBitbucketControlPlane({
    db,
    config: {
      clientId: "client",
      clientSecret: Redacted.make("client-secret"),
      callbackUrl:
        "https://dx.example/v1/integrations/bitbucket/oauth/callback",
    },
    keyring,
    vault,
    fetcher,
  });
  const start = async () =>
    new URL(
      (await service.beginAuthorization(userId, "browser-one"))
        .authorizationUrl,
    ).searchParams.get("state") as string;
  const connect = async () => {
    await service.completeAuthorization(
      userId,
      "browser-one",
      await start(),
      "code",
    );
    return (await readBitbucketConnection(db, userId))!;
  };
  return { db, sqlite, service, start, connect, fetcher, vault, keyring };
};
const seedThread = (sqlite: DatabaseSync, connectionId: string) => {
  const now = new Date().toISOString();
  sqlite
    .prepare(
      "INSERT INTO projects (id,owner_user_id,name,created_at,updated_at) VALUES (?,?,?,?,?)",
    )
    .run(projectId, userId, "project", now, now);
  sqlite
    .prepare(
      "INSERT INTO threads (id,project_id,owner_user_id,created_at,updated_at) VALUES (?,?,?,?,?)",
    )
    .run(threadId, projectId, userId, now, now);
  sqlite
    .prepare(
      "INSERT INTO project_repository (project_id,provider,binding_revision,full_name,web_url,clone_url,created_at,updated_at) VALUES (?,'bitbucket',1,'space/repo','https://bitbucket.org/space/repo','https://bitbucket.org/space/repo.git',?,?)",
    )
    .run(projectId, now, now);
  sqlite
    .prepare(
      "INSERT INTO project_source_authority (project_id,provider,owner_scope,owner_id,owner_grant_id,provider_workspace_id,provider_repository_id,binding_revision,provenance,default_branch,source_health,authorization_epoch,installation_epoch,policy_revision,created_at,updated_at) VALUES (?,'bitbucket','personal',?,?,?, ?,1,'live-grant','main','available',1,0,0,?,?)",
    )
    .run(projectId, userId, connectionId, workspaceId, repositoryId, now, now);
  sqlite
    .prepare(
      "INSERT INTO thread_source_snapshot (thread_id,project_id,binding_revision,provider,repository_full_name,clone_url,default_branch,initial_ref,initial_commit_sha,created_at) VALUES (?,?,1,'bitbucket','space/repo','https://bitbucket.org/space/repo.git','main','refs/heads/main',?,?)",
    )
    .run(threadId, projectId, "a".repeat(40), now);
  sqlite
    .prepare(
      "INSERT INTO thread_source_authority (thread_id,owner_grant_id,provider_workspace_id,provider_repository_id,authorization_epoch,installation_epoch,policy_revision) VALUES (?,?,?,?,1,0,0)",
    )
    .run(threadId, connectionId, workspaceId, repositoryId);
};

describe("Bitbucket OAuth and source lifecycle with migrated SQLite", () => {
  it.each([false, true])(
    "batches discovered identities without reviving revoked connections: %s",
    async (revoke) => {
      const f = await fixture();
      const connection = await f.connect();
      const batch = vi.spyOn(f.db, "batch");
      f.fetcher
        .mockResolvedValueOnce(
          Response.json({ values: [{ workspace: { uuid: workspaceId } }] }),
        )
        .mockResolvedValueOnce(
          Response.json({
            values: [
              {
                permission: "read",
                repository: { ...repository, type: "repository" },
              },
            ],
          }),
        )
        .mockImplementationOnce(async () => {
          if (revoke)
            f.sqlite
              .prepare(
                "UPDATE bitbucket_connection SET status = 'disconnected', authorization_epoch = authorization_epoch + 1 WHERE id = ?",
              )
              .run(connection.id);
          return Response.json(repository);
        });
      if (revoke)
        await expect(f.service.repositories(userId)).rejects.toThrow();
      else
        expect(
          (await f.service.repositories(userId)).repositories,
        ).toHaveLength(1);
      expect(batch).toHaveBeenCalledTimes(1);
      expect(
        f.sqlite
          .prepare("SELECT count(*) AS count FROM bitbucket_repository")
          .get()?.count,
      ).toBe(revoke ? 0 : 1);
    },
  );

  it("binds one-use state to browser and user, persists encrypted credentials", async () => {
    const f = await fixture();
    const state = await f.start();
    await expect(
      f.service.completeAuthorization(userId, "other-browser", state, "code"),
    ).rejects.toThrow();
    await f.service.completeAuthorization(userId, "browser-one", state, "code");
    await expect(
      f.service.completeAuthorization(userId, "browser-one", state, "code"),
    ).rejects.toThrow();
    expect(await f.service.status(userId)).toMatchObject({
      connection: { status: "active", accountName: "person" },
    });
    expect(
      JSON.stringify(
        f.sqlite.prepare("SELECT * FROM integration_credential").all(),
      ),
    ).not.toContain("access-secret");
    expect(f.sqlite.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });
  it("does not reconnect when disconnect races the OAuth callback", async () => {
    const f = await fixture();
    const state = await f.start();
    f.fetcher.mockImplementationOnce(async () => {
      await disconnectBitbucket(f.db, userId);
      return Response.json({
        access_token: "late-access",
        refresh_token: "late-refresh",
        expires_in: 3600,
      });
    });
    await expect(
      f.service.completeAuthorization(userId, "browser-one", state, "code"),
    ).rejects.toThrow();
    expect(await readBitbucketConnection(f.db, userId)).toBeNull();
    expect(
      f.sqlite.prepare("SELECT * FROM integration_credential").all(),
    ).toEqual([]);
  });
  it("rotates tokens once and rejects simultaneous refresh without replay", async () => {
    const f = await fixture();
    const connection = await f.connect();
    f.sqlite
      .prepare("UPDATE bitbucket_connection SET expires_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    let release!: (response: Response) => void;
    let entered!: () => void;
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    f.fetcher.mockImplementationOnce(() => {
      entered();
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    });
    const first = f.service.withConnection(
      userId,
      connection.id,
      async () => "done",
    );
    await started;
    await expect(
      f.service.withConnection(userId, connection.id, async () => "bad"),
    ).rejects.toThrow();
    release(
      Response.json({
        access_token: "rotated-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
      }),
    );
    expect(await first).toBe("done");
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM integration_credential").get()
        ?.n,
    ).toBe(2);
    expect(
      (await readBitbucketConnection(f.db, userId))?.authorization_epoch,
    ).toBe(1);
  });
  it("keeps rotated credentials active when superseded-secret cleanup fails", async () => {
    const f = await fixture();
    const connection = await f.connect();
    const oldAccessId = connection.access_credential_id as string;
    const oldRefreshId = connection.refresh_credential_id as string;
    f.sqlite
      .prepare("UPDATE bitbucket_connection SET expires_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    const remove = f.vault.remove;
    vi.spyOn(f.vault, "remove").mockImplementation((owner, reference) =>
      reference.id === oldRefreshId
        ? Effect.fail(new Error("credential cleanup failed"))
        : remove(owner, reference),
    );

    await expect(
      f.service.withConnection(
        userId,
        connection.id,
        async (accessToken) => accessToken,
      ),
    ).resolves.toBe("access-secret-2");
    const row = await readBitbucketConnection(f.db, userId);
    expect(row).toMatchObject({
      status: "active",
      authorization_epoch: 1,
      refresh_lock_id: null,
      refresh_lock_until: null,
    });
    expect(row?.access_credential_id).not.toBe(oldAccessId);
    expect(row?.refresh_credential_id).not.toBe(oldRefreshId);
    const ids = new Set(
      (
        f.sqlite
          .prepare("SELECT id FROM integration_credential")
          .all() as Array<{ id: string }>
      ).map(({ id }) => id),
    );
    expect(ids).not.toContain(oldAccessId);
    expect(ids).toContain(oldRefreshId);
    expect(ids).toContain(row?.access_credential_id);
    expect(ids).toContain(row?.refresh_credential_id);
    await expect(
      Effect.runPromise(
        f.vault.read(
          f.keyring,
          { scope: "personal", id: userId as never },
          "access-token",
          integrationCredentialReferenceFor(row?.access_credential_id as never),
        ),
      ),
    ).resolves.toBe("access-secret-2");
    await expect(
      Effect.runPromise(
        f.vault.read(
          f.keyring,
          { scope: "personal", id: userId as never },
          "refresh-token",
          integrationCredentialReferenceFor(
            row?.refresh_credential_id as never,
          ),
        ),
      ),
    ).resolves.toBe("refresh-secret-2");
  });
  it("reclaims superseded secrets without invalidating a committed rotation when its re-read fails", async () => {
    const f = await fixture();
    const connection = await f.connect();
    const oldAccessId = connection.access_credential_id as string;
    const oldRefreshId = connection.refresh_credential_id as string;
    f.sqlite
      .prepare("UPDATE bitbucket_connection SET expires_at = ?")
      .run("2000-01-01T00:00:00.000Z");
    const prepare = f.db.prepare.bind(f.db);
    let rotationCommitted = false;
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (
        sql.startsWith("UPDATE bitbucket_connection SET access_credential_id =")
      ) {
        return {
          bind: (...parameters: unknown[]) => {
            const bound = statement.bind(...parameters);
            return {
              run: async () => {
                const result = await bound.run();
                rotationCommitted = result.meta.changes === 1;
                return result;
              },
            };
          },
        } as unknown as D1PreparedStatement;
      }
      if (
        rotationCommitted &&
        sql.startsWith(
          "SELECT * FROM bitbucket_connection WHERE user_id = ?",
        ) &&
        sql.includes("AND id = ?")
      ) {
        rotationCommitted = false;
        return {
          bind: () => ({
            first: async () => {
              throw new Error("transient post-commit D1 read failure");
            },
          }),
        } as unknown as D1PreparedStatement;
      }
      return statement;
    });

    await expect(
      f.service.withConnection(
        userId,
        connection.id,
        async () => "unreachable",
      ),
    ).rejects.toEqual(new BitbucketProviderError({ category: "unavailable" }));

    const row = await readBitbucketConnection(f.db, userId);
    expect(row).toMatchObject({
      status: "active",
      authorization_epoch: connection.authorization_epoch,
      refresh_lock_id: null,
      refresh_lock_until: null,
    });
    expect(row?.access_credential_id).not.toBe(oldAccessId);
    expect(row?.refresh_credential_id).not.toBe(oldRefreshId);
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM integration_credential").get()
        ?.n,
    ).toBe(2);
    for (const [purpose, id] of [
      ["access-token", oldAccessId],
      ["refresh-token", oldRefreshId],
    ] as const) {
      await expect(
        Effect.runPromise(
          f.vault.read(
            f.keyring,
            { scope: "personal", id: userId as never },
            purpose,
            integrationCredentialReferenceFor(id as never),
          ),
        ),
      ).rejects.toThrow();
    }
  });
  it.each(["zero-row", "lost-ack"] as const)(
    "requires reauthorization when the replacement commit has a %s result",
    async (failure) => {
      const f = await fixture();
      const connection = await f.connect();
      f.sqlite
        .prepare("UPDATE bitbucket_connection SET expires_at = ?")
        .run("2000-01-01T00:00:00.000Z");
      if (failure === "zero-row") {
        f.fetcher.mockImplementationOnce(async () => {
          f.sqlite
            .prepare(
              "UPDATE bitbucket_connection SET status = 'reauthorization-required', authorization_epoch = authorization_epoch + 1, refresh_lock_id = NULL, refresh_lock_until = NULL",
            )
            .run();
          return Response.json({
            access_token: "stored-access",
            refresh_token: "stored-refresh",
            expires_in: 3600,
          });
        });
      } else {
        const prepare = f.db.prepare.bind(f.db);
        vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
          const statement = prepare(sql);
          if (
            !sql.startsWith(
              "UPDATE bitbucket_connection SET access_credential_id =",
            )
          )
            return statement;
          return {
            bind: (...parameters: unknown[]) => {
              const bound = statement.bind(...parameters);
              return {
                run: async () => {
                  await bound.run();
                  throw new Error("lost D1 commit acknowledgement");
                },
              };
            },
          } as unknown as D1PreparedStatement;
        });
      }

      await expect(
        f.service.withConnection(
          userId,
          connection.id,
          async () => "unreachable",
        ),
      ).rejects.toThrow();

      expect(await readBitbucketConnection(f.db, userId)).toMatchObject({
        status: "reauthorization-required",
        authorization_epoch: connection.authorization_epoch + 1,
        refresh_lock_id: null,
        refresh_lock_until: null,
      });
    },
  );
  it.each([
    "refresh-read-rpc",
    "provider-refresh-rpc",
    "access-store-rpc",
    "refresh-store-rpc",
    "commit-rpc",
  ] as const)(
    "requires reauthorization after a pre-commit %s failure",
    async (failure) => {
      const f = await fixture();
      const connection = await f.connect();
      f.sqlite
        .prepare("UPDATE bitbucket_connection SET expires_at = ?")
        .run("2000-01-01T00:00:00.000Z");
      if (failure === "refresh-read-rpc") {
        const read = f.vault.read;
        vi.spyOn(f.vault, "read").mockImplementation(
          (keyring, owner, purpose, reference) =>
            purpose === "refresh-token"
              ? Effect.fail(new Error("transient credential read failure"))
              : read(keyring, owner, purpose, reference),
        );
      } else if (failure === "provider-refresh-rpc") {
        f.fetcher.mockRejectedValueOnce(
          new Error("transient provider RPC failure"),
        );
      } else if (
        failure === "access-store-rpc" ||
        failure === "refresh-store-rpc"
      ) {
        const put = f.vault.put;
        const failedPut = failure === "access-store-rpc" ? 1 : 2;
        let puts = 0;
        vi.spyOn(f.vault, "put").mockImplementation(
          (keyring, owner, purpose, plaintext) =>
            ++puts === failedPut
              ? Effect.fail(new Error("transient credential store failure"))
              : put(keyring, owner, purpose, plaintext),
        );
      } else {
        const prepare = f.db.prepare.bind(f.db);
        vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
          const statement = prepare(sql);
          if (
            !sql.startsWith(
              "UPDATE bitbucket_connection SET access_credential_id =",
            )
          )
            return statement;
          return {
            bind: () => ({
              run: async () => {
                throw new Error("transient replacement commit RPC failure");
              },
            }),
          } as unknown as D1PreparedStatement;
        });
      }
      const callback = vi.fn();

      await expect(
        f.service.withConnection(userId, connection.id, callback),
      ).rejects.toThrow();

      expect(callback).not.toHaveBeenCalled();
      expect(await readBitbucketConnection(f.db, userId)).toMatchObject({
        status: "reauthorization-required",
        authorization_epoch: connection.authorization_epoch + 1,
        access_credential_id: connection.access_credential_id,
        refresh_credential_id: connection.refresh_credential_id,
        refresh_lock_id: null,
        refresh_lock_until: null,
      });
    },
  );
  it("marks revoked consent for reconnect but leaves outages retryable", async () => {
    const f = await fixture();
    await f.connect();
    f.fetcher.mockResolvedValueOnce(
      new Response("provider down", { status: 503 }),
    );
    await expect(f.service.status(userId)).rejects.toThrow();
    expect((await readBitbucketConnection(f.db, userId))?.status).toBe(
      "active",
    );
    f.fetcher.mockResolvedValueOnce(new Response("revoked", { status: 401 }));
    expect(await f.service.status(userId)).toMatchObject({
      connection: { status: "reauthorization-required" },
    });
    expect(
      (await readBitbucketConnection(f.db, userId))?.authorization_epoch,
    ).toBe(2);
  });
  it("requires reauthorization after an uncertain or crashed refresh", async () => {
    const f = await fixture();
    const row = await f.connect();
    f.sqlite
      .prepare(
        "UPDATE bitbucket_connection SET refresh_lock_id='crashed',refresh_lock_until='2000-01-01T00:00:00.000Z'",
      )
      .run();
    f.fetcher.mockClear();
    await expect(
      f.service.withConnection(userId, row.id, async () => undefined),
    ).rejects.toThrow();
    expect(f.fetcher).not.toHaveBeenCalled();
    expect((await readBitbucketConnection(f.db, userId))?.status).toBe(
      "reauthorization-required",
    );
  });
  it("scopes guest leases to a live immutable Thread and stops them on disconnect", async () => {
    const f = await fixture();
    const row = await f.connect();
    seedThread(f.sqlite, row.id);
    vi.stubGlobal("fetch", f.fetcher);
    expect(
      await readBitbucketThreadAuthority(f.db, threadId, userId),
    ).toMatchObject({ grantId: row.id });
    const app = new Hono<AppEnv>();
    app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
    await Effect.runPromise(
      bitbucketRuntimeBroker(f.db, {
        ...bindings,
        DB: f.db,
      }).withCommandEnvironment(
        threadId,
        userId,
        { operation: "fetch", invocationSource: "checkout" },
        (environment) =>
          Effect.promise(async () => {
            expect(JSON.stringify(environment)).not.toContain("access-secret");
            const auth = {
              authorization: `Basic ${btoa(`dx:${environment.DX_BITBUCKET_GIT_TOKEN}`)}`,
            };
            expect(
              (
                await app.request(
                  "https://dx.example/api/source/bitbucket/git/other/repo.git/info/refs?service=git-upload-pack",
                  { headers: auth },
                  { ...bindings, DB: f.db },
                )
              ).status,
            ).toBe(403);
            expect(
              (
                await app.request(
                  "https://dx.example/api/source/bitbucket/git/space/repo.git/info/refs?service=git-receive-pack",
                  { headers: auth },
                  { ...bindings, DB: f.db },
                )
              ).status,
            ).toBe(403);
            await disconnectBitbucket(f.db, userId);
            expect(
              (
                await app.request(
                  "https://dx.example/api/source/bitbucket/git/space/repo.git/info/refs?service=git-upload-pack",
                  { headers: auth },
                  { ...bindings, DB: f.db },
                )
              ).status,
            ).toBe(403);
          }),
      ),
    );
    expect(f.sqlite.prepare("SELECT * FROM bitbucket_git_lease").all()).toEqual(
      [],
    );
    expect(
      f.sqlite.prepare("SELECT * FROM integration_credential").all(),
    ).toEqual([]);
    expect(
      f.sqlite.prepare("SELECT count(*) n FROM thread_source_snapshot").get()
        ?.n,
    ).toBe(1);
  });
  it("returns 401 with a Basic challenge for malformed base64 credentials", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
    const response = await app.request(
      "https://dx.example/api/source/bitbucket/git/space/repo.git/info/refs?service=git-upload-pack",
      { headers: { authorization: "Basic !!!not-base64!!!" } },
      bindings,
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe(
      'Basic realm="dx source"',
    );
  });
  it("preserves a successful command when lease cleanup fails and expiry still denies the lease", async () => {
    const f = await fixture();
    const row = await f.connect();
    seedThread(f.sqlite, row.id);
    vi.stubGlobal("fetch", f.fetcher);
    const prepare = f.db.prepare.bind(f.db);
    let failCleanup = false;
    vi.spyOn(f.db, "prepare").mockImplementation((sql: string) => {
      const statement = prepare(sql);
      if (
        !failCleanup ||
        sql !== "DELETE FROM bitbucket_git_lease WHERE id_hash = ?"
      )
        return statement;
      return {
        bind: () => ({
          run: async () => {
            throw new Error("lease cleanup failed");
          },
        }),
      } as unknown as D1PreparedStatement;
    });
    let leaseToken = "";
    await expect(
      Effect.runPromise(
        bitbucketRuntimeBroker(f.db, {
          ...bindings,
          DB: f.db,
        }).withCommandEnvironment(
          threadId,
          userId,
          { operation: "fetch", invocationSource: "checkout" },
          (environment) => {
            leaseToken = environment.DX_BITBUCKET_GIT_TOKEN;
            failCleanup = true;
            return Effect.succeed("command-result");
          },
        ),
      ),
    ).resolves.toBe("command-result");
    expect(
      f.sqlite.prepare("SELECT count(*) AS n FROM bitbucket_git_lease").get()
        ?.n,
    ).toBe(1);
    f.sqlite
      .prepare(
        "UPDATE bitbucket_git_lease SET expires_at = '2000-01-01T00:00:00.000Z'",
      )
      .run();
    const app = new Hono<AppEnv>();
    app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
    const response = await app.request(
      "https://dx.example/api/source/bitbucket/git/space/repo.git/info/refs?service=git-upload-pack",
      { headers: { authorization: `Basic ${btoa(`dx:${leaseToken}`)}` } },
      { ...bindings, DB: f.db },
    );
    expect(response.status).toBe(403);
  });
  it("proxies bounded Git reads and writes and leaves repository access to Bitbucket", async () => {
    const f = await fixture();
    const row = await f.connect();
    seedThread(f.sqlite, row.id);
    const original = f.fetcher.getMockImplementation()!;
    let allowed = true;
    const upstream: Array<{ url: string; body: string; headers: Headers }> = [];
    f.fetcher.mockImplementation(async (url, init) => {
      if (String(url).startsWith("https://bitbucket.org/")) {
        if (!allowed) return new Response("removed", { status: 404 });
        upstream.push({
          url: String(url),
          body: init?.body ? await new Response(init.body).text() : "",
          headers: new Headers(init?.headers),
        });
        return new Response("git-response", {
          headers: {
            "content-type": "application/x-git-upload-pack-result",
            "set-cookie": "do-not-forward",
          },
        });
      }
      return original(url, init);
    });
    vi.stubGlobal("fetch", f.fetcher);
    const app = new Hono<AppEnv>();
    app.route("/api/source/bitbucket/git", bitbucketGitGatewayRoutes);
    await Effect.runPromise(
      bitbucketRuntimeBroker(f.db, {
        ...bindings,
        DB: f.db,
      }).withCommandEnvironment(
        threadId,
        userId,
        {
          operation: "contents-push",
          targetBranch: "feature",
          invocationSource: "agent-command",
        },
        (environment) =>
          Effect.promise(async () => {
            const headers = {
              authorization: `Basic ${btoa(`dx:${environment.DX_BITBUCKET_GIT_TOKEN}`)}`,
              cookie: "guest-cookie",
            };
            const request = (path: string, init: RequestInit = {}) =>
              app.request(
                `https://dx.example/api/source/bitbucket/git/space/repo.git/${path}`,
                { ...init, headers },
                { ...bindings, DB: f.db },
              );
            const response = await request("info/refs?service=git-upload-pack");
            expect(response.status).toBe(200);
            expect(await response.text()).toBe("git-response");
            expect(response.headers.has("set-cookie")).toBe(false);
            expect(upstream[0]?.headers.get("cookie")).toBeNull();
            expect(upstream[0]?.headers.get("authorization")).toBe(
              `Basic ${btoa("x-token-auth:access-secret-1")}`,
            );
            const line = `${"a".repeat(40)} ${"b".repeat(40)} refs/heads/feature\0report-status\n`;
            const body =
              (line.length + 4).toString(16).padStart(4, "0") +
              line +
              "0000PACK";
            expect(
              (await request("git-receive-pack", { method: "POST", body }))
                .status,
            ).toBe(200);
            expect(upstream[1]?.body).toBe(body);
            // Git gzips upload-pack bodies over 1 KiB; Bitbucket gets them decoded.
            const wants = `0032want ${"c".repeat(40)}\n`.repeat(40);
            const gzipped = new Response(
              new Blob([wants])
                .stream()
                .pipeThrough(new CompressionStream("gzip")),
            ).body;
            const decoded = await app.request(
              "https://dx.example/api/source/bitbucket/git/space/repo.git/git-upload-pack",
              {
                method: "POST",
                body: gzipped,
                headers: { ...headers, "content-encoding": "gzip" },
                duplex: "half",
              } as RequestInit,
              { ...bindings, DB: f.db },
            );
            expect(decoded.status).toBe(200);
            expect(upstream[2]?.body).toBe(wants);
            expect(upstream[2]?.headers.get("content-encoding")).toBeNull();
            expect(
              (
                await app.request(
                  "https://dx.example/api/source/bitbucket/git/space/repo.git/git-upload-pack",
                  {
                    method: "POST",
                    body: wants,
                    headers: { ...headers, "content-encoding": "br" },
                  },
                  { ...bindings, DB: f.db },
                )
              ).status,
            ).toBe(403);
            allowed = false;
            expect(
              (await request("info/refs?service=git-upload-pack")).status,
            ).toBe(403);
            expect(upstream).toHaveLength(3);
            expect((await readBitbucketConnection(f.db, userId))?.status).toBe(
              "active",
            );
            allowed = true;
            f.sqlite
              .prepare(
                "UPDATE bitbucket_git_lease SET expires_at = '2000-01-01T00:00:00.000Z'",
              )
              .run();
            expect(
              (await request("info/refs?service=git-upload-pack")).status,
            ).toBe(403);
          }),
      ),
    );
    // A native Git lease follows the owner's connection to any repository.
    await Effect.runPromise(
      bitbucketRuntimeBroker(f.db, {
        ...bindings,
        DB: f.db,
      }).withCommandEnvironment(
        threadId,
        userId,
        { operation: "contents-push", invocationSource: "git-helper" },
        (environment) =>
          Effect.promise(async () => {
            const response = await app.request(
              "https://dx.example/api/source/bitbucket/git/elsewhere/other/info/refs?service=git-receive-pack",
              {
                headers: {
                  authorization: `Basic ${btoa(`dx:${environment.DX_BITBUCKET_GIT_TOKEN}`)}`,
                },
              },
              { ...bindings, DB: f.db },
            );
            expect(response.status).toBe(200);
            expect(upstream.at(-1)?.url).toBe(
              "https://bitbucket.org/elsewhere/other.git/info/refs?service=git-receive-pack",
            );
          }),
      ),
    );
  });
});
