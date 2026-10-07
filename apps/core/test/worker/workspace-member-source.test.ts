import { env } from "cloudflare:test";
import {
  ProjectRepository,
  ThreadRepository,
  ThreadSourceAuthority,
  ThreadSourceSnapshot,
  UserId,
  WorkspaceId,
} from "@dx/domain";
import { Effect, Schema } from "effect";
import { describe, expect, it } from "vitest";
import { projectViewerAccess } from "../../src/projects/access.js";
import {
  SourceAuthorityRepository,
  SourceAuthorityRepositoryD1,
} from "../../src/source-control/runtime-authority.js";
import { project, thread } from "./fixtures.js";
import { runRepositories } from "./runtime.js";

const now = "2026-10-07T12:00:00.000Z";
const creator = Schema.decodeUnknownSync(UserId)("source-member-creator");
const member = Schema.decodeUnknownSync(UserId)("source-member-member");
const unconnected = Schema.decodeUnknownSync(UserId)("source-member-plain");
const workspaceId = "source-member-workspace";

const workspaceProject = {
  ...project("prj_00000000-0000-4000-8000-000000000b01", creator, "shared"),
  workspaceId: Schema.decodeUnknownSync(WorkspaceId)(workspaceId),
};

const seed = async () => {
  await env.DB.batch([
    ...[creator, member, unconnected].map((id) =>
      env.DB.prepare(
        'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
      ).bind(id, id, `${id}@example.test`, now, now),
    ),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, 'Source Team', 'source-team', 1)",
    ).bind(workspaceId),
    env.DB.prepare(
      `INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES
         ('sm-creator', ?1, ?2, 'owner', 1),
         ('sm-member', ?1, ?3, 'member', 2),
         ('sm-plain', ?1, ?4, 'member', 3)`,
    ).bind(workspaceId, creator, member, unconnected),
    env.DB.prepare(`
      INSERT INTO github_installation (
        installation_id, app_id, provider_account_id, provider_account_type,
        provider_account_login, repository_selection, status,
        permissions_version, created_at, updated_at
      ) VALUES ('9301', '12345', '8301', 'organization', 'team', 'selected', 'active', 1, ?, ?)
    `).bind(now, now),
    env.DB.prepare(`
      INSERT INTO github_owner_grant (
        id, owner_scope, owner_id, installation_id, status,
        created_by_user_id, created_at, updated_at
      ) VALUES ('grant-creator', 'personal', ?1, '9301', 'active', ?1, ?3, ?3),
               ('grant-member', 'personal', ?2, '9301', 'active', ?2, ?3, ?3)
    `).bind(creator, member, now),
    env.DB.prepare(`
      INSERT INTO github_installation_repository (
        installation_id, provider_repository_id, full_name, web_url,
        visibility, entitled, last_reconciled_at
      ) VALUES ('9301', '7301', 'team/repository',
        'https://github.com/team/repository', 'private', 1, ?)
    `).bind(now),
  ]);
  await runRepositories(
    Effect.gen(function* () {
      const projects = yield* ProjectRepository;
      yield* projects.insert(workspaceProject);
      yield* projects.rebindRepositoryOwned(
        workspaceProject.id,
        creator,
        0,
        {
          provider: "github",
          bindingRevision: 1,
          fullName: "team/repository",
          webUrl: "https://github.com/team/repository",
          cloneUrl: "https://github.com/team/repository.git",
        },
        {
          provider: "github",
          ownerScope: "personal",
          ownerId: creator,
          grantId: "grant-creator",
          installationId: "9301",
          providerRepositoryId: "7301",
          bindingRevision: 1,
          provenance: "live-grant",
          defaultBranch: "main",
          health: { state: "available" },
          authorizationEpoch: 1,
          installationEpoch: 1,
          policyRevision: 0,
        },
      );
    }),
  );
};

const insertThread = (id: string, owner: UserId, grantId: string) => {
  const entity = thread(id, workspaceProject.id, owner, now);
  return runRepositories(
    Effect.gen(function* () {
      yield* (yield* ThreadRepository).insert(entity, {
        kind: "finalized",
        snapshot: Schema.decodeUnknownSync(ThreadSourceSnapshot)({
          version: 2,
          threadId: entity.id,
          projectId: workspaceProject.id,
          bindingRevision: 1,
          provider: "github",
          repositoryName: "team/repository",
          cloneUrl: "https://github.com/team/repository.git",
          defaultBranch: "main",
          initialRef: "refs/heads/main",
          sourceRevision: "b".repeat(40),
          capturedAt: now,
        }),
        authority: Schema.decodeUnknownSync(ThreadSourceAuthority)({
          threadId: entity.id,
          grantId,
          installationId: "9301",
          providerRepositoryId: "7301",
          authorizationEpoch: 1,
          installationEpoch: 1,
          policyRevision: 0,
          privateSubmoduleRepositoryIds: [],
        }),
      });
    }),
  ).then(() => entity);
};

describe("workspace member source access", () => {
  it("clones a workspace Project through each member's own grant", async () => {
    await seed();

    const access = await projectViewerAccess(env.DB, member, [
      workspaceProject.id,
    ]);
    expect(access.get(workspaceProject.id)).toEqual({
      canManage: false,
      threads: { status: "available" },
    });
    const plain = await projectViewerAccess(env.DB, unconnected, [
      workspaceProject.id,
    ]);
    expect(plain.get(workspaceProject.id)?.threads).toEqual({
      status: "connect",
      provider: "github",
    });

    // The creator's grant never admits another member's Thread.
    await expect(
      insertThread(
        "thr_00000000-0000-4000-8000-000000000b02",
        member,
        "grant-creator",
      ),
    ).rejects.toBeDefined();

    const memberThread = await insertThread(
      "thr_00000000-0000-4000-8000-000000000b03",
      member,
      "grant-member",
    );
    const resolve = (actor: UserId) =>
      Effect.runPromise(
        Effect.gen(function* () {
          return yield* (yield* SourceAuthorityRepository).resolve(
            memberThread.id,
            actor,
            { operation: "fetch", invocationSource: "agent-command" },
          );
        }).pipe(Effect.provide(SourceAuthorityRepositoryD1(env.DB))),
      );
    await expect(resolve(member)).resolves.toMatchObject({
      ownerScope: "personal",
      ownerId: member,
      grantId: "grant-member",
      providerRepositoryId: "7301",
    });

    // Leaving the workspace removes the member's runtime source authority.
    await env.DB.prepare("DELETE FROM member WHERE userId = ?")
      .bind(member)
      .run();
    await expect(resolve(member)).rejects.toBeDefined();
  });
});
