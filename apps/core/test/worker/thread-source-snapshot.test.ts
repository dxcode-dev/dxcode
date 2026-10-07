import { env } from "cloudflare:test";
import {
  ProjectRepository,
  SourceWorkspaceRepository,
  ThreadRepository,
  ThreadSourceAuthority,
  ThreadSourceIntent,
  ThreadSourceSnapshot,
  UserId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  SourceMutationConflict,
  SourceMutationRepository,
  SourceMutationRepositoryD1,
} from "../../src/source-control/operations.js";
import {
  SourceAuthorityRepository,
  SourceAuthorityRepositoryD1,
} from "../../src/source-control/runtime-authority.js";
import { SourceWorkspaceRepositoryD1 } from "../../src/source-control/source-workspace-repository-d1.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const now = "2026-08-25T12:00:00.000Z";
const owner = Schema.decodeUnknownSync(UserId)("source-snapshot-owner");
const projectEntity = project(
  "prj_00000000-0000-4000-8000-000000000114",
  owner,
  "source-snapshot",
  now,
);

describe("immutable Thread source snapshots", () => {
  it("resolves a repository-less Thread without inventing a source snapshot", async () => {
    const scratchOwner = Schema.decodeUnknownSync(UserId)(
      "source-snapshot-scratch-owner",
    );
    const scratchProject = project(
      "prj_00000000-0000-4000-8000-000000000113",
      scratchOwner,
      "source-snapshot-scratch",
      now,
    );
    const scratchThread = thread(
      "thr_00000000-0000-4000-8000-000000000113",
      scratchProject.id,
      scratchOwner,
      now,
    );
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(
        scratchOwner,
        "Scratch Owner",
        "source-snapshot-scratch@example.test",
        now,
        now,
      )
      .run();
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(scratchProject);
        yield* (yield* ThreadRepository).insert(scratchThread);
      }),
    );

    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceWorkspaceRepository).findByThreadId(
            scratchThread.id,
          );
        }).pipe(Effect.provide(SourceWorkspaceRepositoryD1(env.DB))),
      ),
    ).resolves.toEqual({
      actorUserId: scratchOwner,
      privateSubmodules: [],
    });
    expect(
      await env.DB.prepare(
        "SELECT thread_id FROM thread_source_snapshot WHERE thread_id = ?",
      )
        .bind(scratchThread.id)
        .first(),
    ).toBeNull();
  });

  it("freezes anonymous source intent and finalizes one immutable exact revision", async () => {
    const anonymousOwner = Schema.decodeUnknownSync(UserId)(
      "source-snapshot-anonymous-owner",
    );
    const anonymousProject = {
      ...project(
        "prj_00000000-0000-4000-8000-000000000116",
        anonymousOwner,
        "anonymous-source",
        now,
      ),
      repository: {
        provider: "github" as const,
        bindingRevision: 1,
        fullName: "owner/repository",
        webUrl: "https://github.com/owner/repository",
        cloneUrl: "https://github.com/owner/repository.git",
      },
    };
    const anonymousThread = thread(
      "thr_00000000-0000-4000-8000-000000000116",
      anonymousProject.id,
      anonymousOwner,
      now,
    );
    const sourceIntent = Schema.decodeUnknownSync(ThreadSourceIntent)({
      version: 1,
      threadId: anonymousThread.id,
      projectId: anonymousProject.id,
      bindingRevision: 1,
      provider: "github",
      repositoryName: "owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
      createdAt: now,
    });
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(
        anonymousOwner,
        "Anonymous Source Owner",
        "source-snapshot-anonymous@example.test",
        now,
        now,
      )
      .run();
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(anonymousProject);
        yield* (yield* ThreadRepository).insert(anonymousThread, {
          kind: "pending",
          intent: sourceIntent,
        });
      }),
    );

    await env.DB.prepare(`
      UPDATE project_repository
         SET binding_revision = 2,
             full_name = 'other/repository',
             web_url = 'https://github.com/other/repository',
             clone_url = 'https://github.com/other/repository.git'
       WHERE project_id = ?
    `)
      .bind(anonymousProject.id)
      .run();
    const sourceLayer = SourceWorkspaceRepositoryD1(env.DB);
    const sourceRepository = () =>
      Effect.gen(function* () {
        return yield* SourceWorkspaceRepository;
      }).pipe(Effect.provide(sourceLayer), Effect.runPromise);
    const before = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceWorkspaceRepository).findByThreadId(
          anonymousThread.id,
        );
      }).pipe(Effect.provide(sourceLayer)),
    );
    expect(before).toMatchObject({ intent: sourceIntent });
    expect(before.snapshot).toBeUndefined();
    const finalization = {
      sourceRevision: "b".repeat(40),
      defaultBranch: "trunk",
      initialRef: "refs/heads/trunk",
      capturedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(now),
    };
    const source = await sourceRepository();
    const results = await Promise.all([
      Effect.runPromise(source.finalizeAnonymous(sourceIntent, finalization)),
      Effect.runPromise(
        source.finalizeAnonymous(sourceIntent, {
          ...finalization,
          capturedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
            "2026-08-27T04:00:01.000Z",
          ),
        }),
      ),
    ]);
    expect(results[0]).toEqual(results[1]);
    await expect(
      Effect.runPromise(
        source.finalizeAnonymous(sourceIntent, {
          ...finalization,
          sourceRevision: "c".repeat(40),
        }),
      ),
    ).rejects.toMatchObject({ _tag: "PersistenceUnavailable" });
    const after = await Effect.runPromise(
      source.findByThreadId(anonymousThread.id),
    );
    expect(after).toMatchObject({
      snapshot: {
        projectId: anonymousProject.id,
        bindingRevision: 1,
        repositoryName: "owner/repository",
        sourceRevision: "b".repeat(40),
      },
    });
    expect(after.intent).toBeUndefined();
    expect(after.authority).toBeUndefined();
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceAuthorityRepository).resolve(
            anonymousThread.id,
            anonymousOwner,
            { operation: "fetch", invocationSource: "agent-command" },
          );
        }).pipe(Effect.provide(SourceAuthorityRepositoryD1(env.DB))),
      ),
    ).rejects.toMatchObject({ reason: "stale-snapshot" });
    await expect(
      env.DB.prepare(
        "UPDATE thread_source_snapshot SET initial_commit_sha = ? WHERE thread_id = ?",
      )
        .bind("d".repeat(40), anonymousThread.id)
        .run(),
    ).rejects.toThrow("immutable");
    await expect(
      env.DB.prepare("DELETE FROM thread_source_snapshot WHERE thread_id = ?")
        .bind(anonymousThread.id)
        .run(),
    ).rejects.toThrow("immutable");
  });

  it("atomically stores exact source identity and rejects mutation", async () => {
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(owner, "Source Owner", "source-snapshot@example.test", now, now)
      .run();
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ProjectRepository).insert(projectEntity);
      }),
    );
    await env.DB.prepare(`
      INSERT INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES ('9114', '12345', '8114', 'user', 'owner', 'selected', 'active', 1, ?, ?)
    `)
      .bind(now, now)
      .run();
    await env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-114', 'personal', ?, '9114', 'active', ?, ?, ?)
    `)
      .bind(owner, owner, now, now)
      .run();
    await env.DB.prepare(`
        INSERT INTO github_installation_repository (
          installation_id, provider_repository_id, full_name, web_url,
          visibility, entitled, last_reconciled_at
        ) VALUES ('9114', '7114', 'owner/repository',
          'https://github.com/owner/repository', 'private', 1, ?)
      `)
      .bind(now)
      .run();
    const repositoryIdentity = {
      provider: "github" as const,
      bindingRevision: 1,
      fullName: "owner/repository",
      webUrl: "https://github.com/owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
    };
    const projectAuthority = {
      provider: "github" as const,
      ownerScope: "personal" as const,
      ownerId: owner,
      grantId: "grant-114",
      installationId: "9114",
      providerRepositoryId: "7114",
      bindingRevision: 1,
      provenance: "live-grant" as const,
      defaultBranch: "main",
      health: { state: "available" as const },
      authorizationEpoch: 1,
      installationEpoch: 1,
      policyRevision: 0,
    };
    const rebound = await runRepositories(
      Effect.gen(function* () {
        return yield* (yield* ProjectRepository).rebindRepositoryOwned(
          projectEntity.id,
          owner,
          0,
          repositoryIdentity,
          projectAuthority,
        );
      }),
    );
    expect(rebound.repository?.bindingRevision).toBe(1);
    const repository = rebound.repository;
    if (repository === undefined) throw new Error("Expected rebound source.");
    await expect(
      runRepositories(
        Effect.gen(function* () {
          yield* (yield* ProjectRepository).rebindRepositoryOwned(
            projectEntity.id,
            owner,
            0,
            {
              ...repository,
              bindingRevision: 2,
              fullName: "stale/repository",
            },
            { ...projectAuthority, bindingRevision: 2 },
          );
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      await env.DB.prepare(
        "SELECT full_name FROM project_repository WHERE project_id = ?",
      )
        .bind(projectEntity.id)
        .first(),
    ).toEqual({ full_name: "owner/repository" });
    expect(
      await env.DB.prepare(
        "SELECT id FROM github_owner_grant WHERE id = 'grant-114'",
      ).first(),
    ).toEqual({ id: "grant-114" });
    const threadEntity = thread(
      "thr_00000000-0000-4000-8000-000000000114",
      projectEntity.id,
      owner,
      now,
    );
    const snapshot = Schema.decodeUnknownSync(ThreadSourceSnapshot)({
      version: 2,
      threadId: threadEntity.id,
      projectId: projectEntity.id,
      bindingRevision: 1,
      provider: "github",
      repositoryName: "owner/repository",
      cloneUrl: "https://github.com/owner/repository.git",
      defaultBranch: "main",
      initialRef: "refs/heads/main",
      sourceRevision: "a".repeat(40),
      capturedAt: now,
    });
    const threadAuthority = Schema.decodeUnknownSync(ThreadSourceAuthority)({
      threadId: threadEntity.id,
      grantId: "grant-114",
      installationId: "9114",
      providerRepositoryId: "7114",
      authorizationEpoch: 1,
      installationEpoch: 1,
      policyRevision: 0,
      privateSubmoduleRepositoryIds: [],
    });
    await runRepositories(
      Effect.gen(function* () {
        yield* (yield* ThreadRepository).insert(threadEntity, {
          kind: "finalized",
          snapshot,
          authority: threadAuthority,
        });
      }),
    );

    const resolveAuthority = (actorUserId: string) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceAuthorityRepository).resolve(
            threadEntity.id,
            actorUserId,
            { operation: "fetch", invocationSource: "agent-command" },
          );
        }).pipe(Effect.provide(SourceAuthorityRepositoryD1(env.DB))),
      );
    await expect(resolveAuthority(owner)).resolves.toMatchObject({
      provider: "github",
      ownerScope: "personal",
      grantId: "grant-114",
      installationId: "9114",
      providerRepositoryId: "7114",
    });
    await env.DB.prepare(
      "UPDATE project_repository SET full_name = 'renamed/repository' WHERE project_id = ?",
    )
      .bind(projectEntity.id)
      .run();
    await expect(resolveAuthority(owner)).rejects.toMatchObject({
      reason: "stale-snapshot",
    });
    await env.DB.prepare(
      "UPDATE project_repository SET full_name = 'owner/repository' WHERE project_id = ?",
    )
      .bind(projectEntity.id)
      .run();
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceWorkspaceRepository).findByThreadId(
            threadEntity.id,
          );
        }).pipe(Effect.provide(SourceWorkspaceRepositoryD1(env.DB))),
      ),
    ).resolves.toMatchObject({
      actorUserId: owner,
      snapshot: {
        threadId: threadEntity.id,
        sourceRevision: "a".repeat(40),
      },
      authority: { providerRepositoryId: "7114" },
      privateSubmodules: [],
    });
    await expect(resolveAuthority("cross-owner")).rejects.toMatchObject({
      reason: "source-not-found",
    });

    const stored = await env.DB.prepare(`
      SELECT snapshot.initial_commit_sha, snapshot.initial_ref,
             authority.private_submodule_repository_ids_json
        FROM thread_source_snapshot AS snapshot
        JOIN thread_source_authority AS authority ON authority.thread_id = snapshot.thread_id
       WHERE snapshot.thread_id = ?
    `)
      .bind(threadEntity.id)
      .first<Record<string, string>>();
    expect(stored).toEqual({
      initial_commit_sha: "a".repeat(40),
      initial_ref: "refs/heads/main",
      private_submodule_repository_ids_json: "[]",
    });
    const operationIntent = {
      idempotencyKey: "push-operation-117",
      actorUserId: owner,
      projectId: projectEntity.id,
      threadId: threadEntity.id,
      provider: "github",
      providerRepositoryId: "7114",
      kind: "contents-push" as const,
      expectedRemoteSha: "a".repeat(40),
      intendedSha: "b".repeat(40),
      inputIdentity: "main and exact commit identities",
    };
    const operationLayer = SourceMutationRepositoryD1(env.DB);
    const registerOperation = () =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).register(
            operationIntent,
          );
        }).pipe(Effect.provide(operationLayer)),
      );
    const operation = await registerOperation();
    await expect(registerOperation()).resolves.toEqual(operation);
    const claims = await Promise.allSettled([
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).transition(
            operation,
            "executing",
          );
        }).pipe(Effect.provide(operationLayer)),
      ),
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).transition(
            operation,
            "executing",
          );
        }).pipe(Effect.provide(operationLayer)),
      ),
    ]);
    expect(claims.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const operationRow = await env.DB.prepare(
      "SELECT * FROM source_control_operation WHERE id = ?",
    )
      .bind(operation.id)
      .first<Record<string, unknown>>();
    expect(operationRow).toMatchObject({
      state: "executing",
      attempt: 1,
      version: 2,
      expected_remote_sha: "a".repeat(40),
      intended_sha: "b".repeat(40),
    });
    for (const forbidden of [
      "token",
      "command",
      "output",
      "repository_name",
      "payload",
      "plaintext",
    ])
      expect(Object.keys(operationRow).join(",")).not.toContain(forbidden);
    await expect(
      env.DB.prepare(
        "UPDATE source_control_operation SET intended_sha = ? WHERE id = ?",
      )
        .bind("c".repeat(40), operation.id)
        .run(),
    ).rejects.toThrow("source-control operation");
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).register({
            ...operationIntent,
            intendedSha: "c".repeat(40),
          });
        }).pipe(Effect.provide(operationLayer)),
      ),
    ).rejects.toBeInstanceOf(SourceMutationConflict);
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).register({
            ...operationIntent,
            idempotencyKey: "wrong-tenant-operation-117",
            actorUserId: "not-the-thread-owner",
          });
        }).pipe(Effect.provide(operationLayer)),
      ),
    ).rejects.toMatchObject({ _tag: "SourceMutationUnavailable" });
    const executing = claims.find(
      (claim): claim is PromiseFulfilledResult<typeof operation> =>
        claim.status === "fulfilled",
    )?.value;
    expect(executing).toBeDefined();
    if (executing === undefined) throw new Error("Missing executing operation");
    await expect(
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceMutationRepository).transition(
            executing,
            "executing",
          );
        }).pipe(Effect.provide(operationLayer)),
      ),
    ).rejects.toMatchObject({ _tag: "SourceMutationUnavailable" });
    const reconcileRequired = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceMutationRepository).transition(
          executing,
          "reconcile-required",
          { category: "unavailable" },
        );
      }).pipe(Effect.provide(operationLayer)),
    );
    const retried = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceMutationRepository).transition(
          reconcileRequired,
          "executing",
        );
      }).pipe(Effect.provide(operationLayer)),
    );
    const terminal = await Effect.runPromise(
      Effect.gen(function* () {
        return yield* (yield* SourceMutationRepository).transition(
          retried,
          "failed",
          { category: "rejected" },
        );
      }).pipe(Effect.provide(operationLayer)),
    );
    expect(terminal).toMatchObject({ state: "failed", attempt: 2, version: 5 });
    await expect(
      env.DB.prepare(
        "UPDATE source_control_operation SET updated_at = ? WHERE id = ?",
      )
        .bind(new Date().toISOString(), operation.id)
        .run(),
    ).rejects.toThrow("source-control operation");
    await expect(
      env.DB.prepare("DELETE FROM source_control_operation WHERE id = ?")
        .bind(operation.id)
        .run(),
    ).rejects.toThrow("cannot be deleted");
    await env.DB.prepare(`
      INSERT INTO github_authorization_epoch (subject_kind, subject_id, epoch, updated_at)
      VALUES ('owner-grant', 'grant-114', 2, ?)
    `)
      .bind(now)
      .run();
    await expect(resolveAuthority(owner)).rejects.toMatchObject({
      reason: "stale-authorization-epoch",
    });
    const rejectedThread = thread(
      "thr_00000000-0000-4000-8000-000000000115",
      projectEntity.id,
      owner,
      now,
    );
    await expect(
      runRepositories(
        Effect.gen(function* () {
          yield* (yield* ThreadRepository).insert(rejectedThread, {
            kind: "finalized",
            snapshot: { ...snapshot, threadId: rejectedThread.id },
            authority: { ...threadAuthority, threadId: rejectedThread.id },
          });
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      await env.DB.prepare("SELECT id FROM threads WHERE id = ?")
        .bind(rejectedThread.id)
        .first(),
    ).toBeNull();
    await expect(
      runRepositories(
        Effect.gen(function* () {
          yield* (yield* ProjectRepository).rebindRepositoryOwned(
            projectEntity.id,
            owner,
            1,
            {
              ...repository,
              bindingRevision: 2,
            },
            { ...projectAuthority, bindingRevision: 2 },
          );
        }),
      ),
    ).rejects.toBeDefined();
    expect(
      await env.DB.prepare("SELECT revision FROM projects WHERE id = ?")
        .bind(projectEntity.id)
        .first(),
    ).toEqual({ revision: 1 });
    await expect(
      env.DB.prepare(
        "UPDATE thread_source_snapshot SET initial_commit_sha = ? WHERE thread_id = ?",
      )
        .bind("b".repeat(40), threadEntity.id)
        .run(),
    ).rejects.toThrow("immutable");

    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO organization (id, name, slug, createdAt) VALUES ('workspace-115', 'Workspace 115', 'workspace-115', ?)",
      ).bind(now),
      env.DB.prepare(
        "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES ('member-115', 'workspace-115', ?, 'owner', ?)",
      ).bind(owner, now),
      env.DB.prepare(
        "UPDATE projects SET workspace_id = 'workspace-115' WHERE id = ?",
      ).bind(projectEntity.id),
      env.DB.prepare(
        "UPDATE github_authorization_epoch SET epoch = 1 WHERE subject_kind = 'owner-grant' AND subject_id = 'grant-114'",
      ),
    ]);
    // A workspace Project may bind its member's personal grant; the lease
    // stays the member's own.
    await expect(resolveAuthority(owner)).resolves.toMatchObject({
      ownerScope: "personal",
      ownerId: owner,
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE github_owner_grant SET owner_scope = 'workspace', owner_id = 'workspace-115' WHERE id = 'grant-114'",
      ),
      env.DB.prepare(
        "UPDATE project_source_authority SET owner_scope = 'workspace', owner_id = 'workspace-115' WHERE project_id = ?",
      ).bind(projectEntity.id),
    ]);
    await expect(resolveAuthority(owner)).resolves.toMatchObject({
      ownerScope: "workspace",
      ownerId: "workspace-115",
      policyRevision: 0,
    });
    await env.DB.prepare(
      "DELETE FROM member WHERE organizationId = 'workspace-115' AND userId = ?",
    )
      .bind(owner)
      .run();
    await expect(resolveAuthority(owner)).rejects.toMatchObject({
      reason: "policy-denied",
    });
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE github_owner_grant SET owner_scope = 'personal', owner_id = ? WHERE id = 'grant-114'",
      ).bind(owner),
      env.DB.prepare(
        "UPDATE project_source_authority SET owner_scope = 'personal', owner_id = ? WHERE project_id = ?",
      ).bind(owner, projectEntity.id),
    ]);
    // A former member's personal grant no longer reaches the workspace Project.
    await expect(resolveAuthority(owner)).rejects.toMatchObject({
      reason: "source-not-found",
    });
  });
});
