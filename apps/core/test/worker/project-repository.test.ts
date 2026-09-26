import { env } from "cloudflare:test";
import { Project, ProjectRepository, UserId } from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it, vi } from "vitest";
import { projectPersistenceLogger } from "../../src/logging.js";
import { project } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const owner = Schema.decodeUnknownSync(UserId)("owner-a");
const otherOwner = Schema.decodeUnknownSync(UserId)("owner-b");

describe("ProjectRepository D1", () => {
  it("persists scoped defaults and rejects mutation of the projectless backing row", async () => {
    const configuration = {
      shipAction: "commit" as const,
      commitAuthor: {
        preference: "user" as const,
        name: "Project Owner",
        email: "project-owner@example.test",
      },
      signingPreference: "preferred" as const,
      runnerProfileId: "e2b-large",
      publicCodeEnabled: false,
    };

    const projectId = await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        const first = yield* repository.ensureProjectless(owner, {
          configuration,
        });
        const second = yield* repository.ensureProjectless(owner, {
          configuration,
        });
        expect(second).toBe(first);
        expect(
          (yield* repository.findOwnedById(first, owner)).configuration,
        ).toEqual(configuration);
        expect(
          (yield* Effect.flip(
            repository.updateOwned(first, owner, 0, { name: "Renamed" }),
          ))._tag,
        ).toBe("ProjectNotFound");
        expect(
          (yield* Effect.flip(
            repository.rebindRepositoryOwned(
              first,
              owner,
              0,
              {
                provider: "github",
                bindingRevision: 1,
                fullName: "owner/repository",
                webUrl: "https://github.com/owner/repository",
              },
              {
                provider: "github",
                ownerScope: "personal",
                ownerId: owner,
                grantId: "missing-grant",
                installationId: "missing-installation",
                providerRepositoryId: "missing-repository",
                bindingRevision: 1,
                provenance: "live-grant",
                health: { state: "available" },
                authorizationEpoch: 1,
                installationEpoch: 1,
                policyRevision: 0,
              },
            ),
          ))._tag,
        ).toBe("ProjectNotFound");
        return first;
      }),
    );

    await env.DB.prepare("DELETE FROM projects WHERE id = ?")
      .bind(projectId)
      .run();
  });

  it("inserts, finds, and isolates ownership", async () => {
    const errorLog = vi
      .spyOn(projectPersistenceLogger, "error")
      .mockImplementation(() => {});
    const entity = project(
      "prj_00000000-0000-4000-8000-000000000001",
      owner,
      "Alpha",
    );

    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        yield* repository.insert(entity);
        expect((yield* repository.findOwnedById(entity.id, owner)).name).toBe(
          "Alpha",
        );
        const error = yield* Effect.flip(
          repository.findOwnedById(entity.id, otherOwner),
        );
        expect(error._tag).toBe("ProjectNotFound");
      }),
    );
    expect(errorLog).not.toHaveBeenCalled();
    errorLog.mockRestore();
  });

  it("atomically inserts a Project with a live GitHub grant", async () => {
    const now = "2026-08-27T04:00:00.000Z";
    await env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    )
      .bind(owner, "Project Owner", "project-owner@example.test", now, now)
      .run();
    await env.DB.prepare(`
      INSERT INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES ('9201', '12345', '8201', 'user', 'owner', 'all', 'active', 1, ?, ?)
    `)
      .bind(now, now)
      .run();
    await env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-201', 'personal', ?, '9201', 'active', ?, ?, ?)
    `)
      .bind(owner, owner, now, now)
      .run();
    await env.DB.prepare(`
      INSERT INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES
        ('9201', '7201', 'owner/repository',
          'https://github.com/owner/repository', 'private', 1, ?),
        ('9201', '7202', 'owner/rebound',
          'https://github.com/owner/rebound', 'public', 1, ?)
    `)
      .bind(now, now)
      .run();
    const entity = Schema.decodeUnknownSync(Project)({
      id: "prj_00000000-0000-4000-8000-000000000201",
      ownerUserId: owner,
      name: "github-source",
      repository: {
        provider: "github",
        bindingRevision: 1,
        fullName: "owner/repository",
        webUrl: "https://github.com/owner/repository",
        cloneUrl: "https://github.com/owner/repository.git",
      },
      configuration: {
        shipAction: "ship",
        commitAuthor: {
          preference: "dx",
          name: "dx",
          email: "noreply@dx.local",
        },
        signingPreference: "disabled",
        runnerProfileId: "e2b-default",
        publicCodeEnabled: false,
      },
      createdAt: now,
      updatedAt: now,
    });

    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        yield* repository.insert(entity, {
          provider: "github",
          ownerScope: "personal",
          ownerId: owner,
          grantId: "grant-201",
          installationId: "9201",
          providerRepositoryId: "7201",
          bindingRevision: 1,
          provenance: "live-grant",
          defaultBranch: "main",
          health: { state: "available" },
          authorizationEpoch: 1,
          installationEpoch: 1,
          policyRevision: 0,
        });
        expect(
          (yield* repository.findOwnedById(entity.id, owner)).repository,
        ).toMatchObject({
          fullName: "owner/repository",
        });
        const rebound = yield* repository.rebindRepositoryOwned(
          entity.id,
          owner,
          0,
          {
            provider: "github",
            bindingRevision: 2,
            fullName: "owner/rebound",
            webUrl: "https://github.com/owner/rebound",
            cloneUrl: "https://github.com/owner/rebound.git",
          },
          {
            provider: "github",
            ownerScope: "personal",
            ownerId: owner,
            grantId: "grant-201",
            installationId: "9201",
            providerRepositoryId: "7202",
            bindingRevision: 2,
            provenance: "live-grant",
            defaultBranch: "main",
            health: { state: "available" },
            authorizationEpoch: 1,
            installationEpoch: 1,
            policyRevision: 0,
          },
        );
        expect(rebound).toMatchObject({
          revision: 1,
          repository: {
            bindingRevision: 2,
            fullName: "owner/rebound",
          },
        });
      }),
    );
    await expect(
      env.DB.prepare(`
        SELECT binding_revision, provider_repository_id
          FROM project_source_authority
         WHERE project_id = ?
      `)
        .bind(entity.id)
        .first(),
    ).resolves.toEqual({
      binding_revision: 2,
      provider_repository_id: "7202",
    });
    await env.DB.prepare("DELETE FROM projects WHERE id = ?")
      .bind(entity.id)
      .run();
  });

  it("reports invalid cursors without classifying them as storage failures", async () => {
    const errorLog = vi
      .spyOn(projectPersistenceLogger, "error")
      .mockImplementation(() => {});
    const warnLog = vi
      .spyOn(projectPersistenceLogger, "warn")
      .mockImplementation(() => {});

    const error = await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        return yield* Effect.flip(
          repository.listOwned(owner, { cursor: "not-a-cursor" }),
        );
      }),
    );

    expect(error._tag).toBe("InvalidPageCursor");
    expect(errorLog).not.toHaveBeenCalled();
    expect(warnLog).toHaveBeenCalledWith(
      "Project persistence rejected invalid input.",
      expect.objectContaining({ outcome: "InvalidPageCursor" }),
    );
    errorLog.mockRestore();
    warnLog.mockRestore();
  });

  it("paginates equal timestamps by descending ID without gaps", async () => {
    const entities = [3, 1, 2].map((suffix) =>
      project(
        `prj_00000000-0000-4000-8000-00000000000${suffix}`,
        owner,
        `Project ${suffix}`,
      ),
    );

    await runRepositories(
      Effect.gen(function* () {
        const repository = yield* ProjectRepository;
        yield* Effect.all(entities.map(repository.insert));
        const first = yield* repository.listOwned(owner, { limit: 2 });
        expect(first.items.map(({ id }) => id)).toEqual([
          entities[0]?.id,
          entities[2]?.id,
        ]);
        expect(first.nextCursor).toBeDefined();
        const second = yield* repository.listOwned(owner, {
          limit: 2,
          cursor: first.nextCursor,
        });
        expect(second.items.map(({ id }) => id)).toEqual([entities[1]?.id]);
        expect(second.nextCursor).toBeUndefined();
      }),
    );
  });
});
