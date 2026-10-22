import { env } from "cloudflare:test";
import { Principal, ProjectId, UserId, WorkspaceId } from "@dx/domain";
import { Effect, Layer, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { SettingsAudit } from "../../src/settings/audit.js";
import { McpServerRepositoryD1 } from "../../src/settings/mcp-servers/repository-d1.js";
import {
  readSkillResource,
  SkillResourceForbidden,
} from "../../src/settings/skills/execution.js";
import { SkillRepositoryD1 } from "../../src/settings/skills/repository-d1.js";
import { SkillService } from "../../src/settings/skills/service.js";

const owner = Schema.decodeUnknownSync(UserId)("skill-policy-owner");
const workspaceId = Schema.decodeUnknownSync(WorkspaceId)(
  "skill-policy-workspace",
);
const projectId = Schema.decodeUnknownSync(ProjectId)(
  "prj_00000000-0000-4000-8000-000000000044",
);
const threadId = "thr_00000000-0000-4000-8000-000000000044";
const otherThreadId = "thr_00000000-0000-4000-8000-000000000045";
const personalId = "skl_00000000-0000-4000-8000-000000000044";
const workspaceIdConflict = "skl_00000000-0000-4000-8000-000000000045";
const workspaceOnlyId = "skl_00000000-0000-4000-8000-000000000046";
const timestamp = "2026-08-23T00:00:00.000Z";
const versionIntegrity = "a".repeat(64);

const resourceIntegrity = async (content: string) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(content),
  );
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
};

const insertSkill = (
  id: string,
  scope: "personal" | "workspace",
  targetId: string,
  name: string,
  mcpServerIds: ReadonlyArray<string> = [],
) => [
  env.DB.prepare(
    `INSERT INTO skill (
       id, scope, target_id, name, enabled, active_version, pinned,
       created_at, updated_at
     ) VALUES (?, ?, ?, ?, 1, 1, 0, ?, ?)`,
  ).bind(id, scope, targetId, name, timestamp, timestamp),
  env.DB.prepare(
    `INSERT INTO skill_version (
       skill_id, version, description, instructions, manifest_json,
       mcp_server_ids_json, source_type, source_label, integrity,
       created_at, created_by_user_id
     ) VALUES (?, 1, ?, ?, ?, ?, 'browser-files', ?, ?, ?, ?)`,
  ).bind(
    id,
    `${name} description`,
    `${name} instructions`,
    JSON.stringify({
      schemaVersion: 1,
      name,
      description: `${name} description`,
    }),
    JSON.stringify(mcpServerIds),
    "Reviewed browser folder",
    versionIntegrity,
    timestamp,
    owner,
  ),
];

const principal = Schema.decodeUnknownSync(Principal)({
  userId: owner,
  credentialScopes: ["personal", "workspace"],
});

/** The skill IDs a new Thread of the owner loads. */
const listEffective = () =>
  Effect.runPromise(
    Effect.gen(function* () {
      const service = yield* SkillService;
      const resolved = yield* service.resolveForThread(principal, projectId);
      return resolved.map(({ id }) => ({ skill: { id } }));
    }).pipe(
      Effect.provide(
        SkillService.layer.pipe(
          Layer.provide(
            Layer.mergeAll(
              SkillRepositoryD1(env.DB),
              McpServerRepositoryD1(env.DB),
              SettingsAudit.layer,
            ),
          ),
        ),
      ),
    ),
  );

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(owner, "Skill Owner", "skill-policy@example.com", 1, 1),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Skill Workspace", "skill-policy-workspace", 1),
    env.DB.prepare(
      "INSERT INTO member (id, organizationId, userId, role, createdAt) VALUES (?, ?, ?, ?, ?)",
    ).bind("skill-policy-membership", workspaceId, owner, "member", 1),
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(projectId, owner, "Skill policy project", timestamp, timestamp),
    ...insertSkill(personalId, "personal", owner, "review-guidelines"),
    ...insertSkill(
      workspaceIdConflict,
      "workspace",
      workspaceId,
      "review-guidelines",
    ),
    ...insertSkill(
      workspaceOnlyId,
      "workspace",
      workspaceId,
      "workspace-standards",
    ),
  ]);
});

describe("skill precedence and immutable resource policy in D1", () => {
  it("applies personal-over-workspace precedence and the workspace policy seam", async () => {
    // A personal skill replaces the workspace skill with the same name.
    expect((await listEffective()).map(({ skill }) => skill.id)).toEqual([
      personalId,
      workspaceOnlyId,
    ]);

    await env.DB.prepare("UPDATE skill SET enabled = 0 WHERE id = ?")
      .bind(personalId)
      .run();
    expect((await listEffective()).map(({ skill }) => skill.id)).toEqual([
      workspaceIdConflict,
      workspaceOnlyId,
    ]);

    // A workspace that blocks personal skills keeps its own in place.
    await env.DB.batch([
      env.DB.prepare("UPDATE skill SET enabled = 1 WHERE id = ?").bind(
        personalId,
      ),
      env.DB.prepare(
        "INSERT INTO skill_workspace_policy (workspace_id, allow_personal_skills) VALUES (?, 0)",
      ).bind(workspaceId),
    ]);
    expect((await listEffective()).map(({ skill }) => skill.id)).toEqual([
      workspaceIdConflict,
      workspaceOnlyId,
    ]);

    await env.DB.prepare(
      "UPDATE skill SET removed_at = ?, enabled = 0 WHERE id IN (?, ?)",
    )
      .bind(timestamp, workspaceIdConflict, workspaceOnlyId)
      .run();
    expect(await listEffective()).toEqual([]);
  });

  it("falls back to the workspace skill when the personal one of that name cannot load", async () => {
    // The personal skill needs an MCP server with no reviewed tools, so a
    // Thread drops it; the workspace skill of the same name loads instead.
    const unreviewedServer = "mcp_00000000-0000-4000-8000-000000000044";
    const personalWithMcp = "skl_00000000-0000-4000-8000-000000000047";
    await env.DB.batch([
      env.DB.prepare("UPDATE skill SET enabled = 0 WHERE id = ?").bind(
        personalId,
      ),
      ...insertSkill(
        personalWithMcp,
        "personal",
        owner,
        "workspace-standards",
        [unreviewedServer],
      ),
    ]);
    expect((await listEffective()).map(({ skill }) => skill.id)).toEqual([
      workspaceIdConflict,
      workspaceOnlyId,
    ]);
  });

  it("authorizes lazy resources only through a Thread's immutable snapshot, even after removal", async () => {
    const content = "Private reviewed resource";
    const digest = await resourceIntegrity(content);
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO skill_resource (
           skill_id, version, path, media_type, content, size_bytes, integrity
         ) VALUES (?, 1, 'resources/checklist.md', 'text/markdown', ?, ?, ?)`,
      ).bind(
        personalId,
        content,
        new TextEncoder().encode(content).byteLength,
        digest,
      ),
      env.DB.prepare(
        `INSERT INTO threads (
           id, project_id, owner_user_id, skill_snapshot_json, created_at, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?)`,
      ).bind(
        threadId,
        projectId,
        owner,
        JSON.stringify([
          {
            id: personalId,
            version: 1,
            name: "review-guidelines",
            scope: "personal",
            integrity: versionIntegrity,
          },
        ]),
        timestamp,
        timestamp,
      ),
      env.DB.prepare(
        `INSERT INTO threads (
           id, project_id, owner_user_id, skill_snapshot_json, created_at, updated_at
         ) VALUES (?, ?, ?, '[]', ?, ?)`,
      ).bind(otherThreadId, projectId, owner, timestamp, timestamp),
      env.DB.prepare(
        "UPDATE skill SET removed_at = ?, enabled = 0 WHERE id = ?",
      ).bind(timestamp, personalId),
    ]);

    const resource = await Effect.runPromise(
      readSkillResource(
        { DB: env.DB } as Bindings,
        threadId,
        personalId,
        1,
        "resources/checklist.md",
      ),
    );
    expect(resource).toMatchObject({
      skillId: personalId,
      version: 1,
      content,
      integrity: digest,
    });

    await expect(
      Effect.runPromise(
        readSkillResource(
          { DB: env.DB } as Bindings,
          otherThreadId,
          personalId,
          1,
          "resources/checklist.md",
        ),
      ),
    ).rejects.toBeInstanceOf(SkillResourceForbidden);
    await expect(
      Effect.runPromise(
        readSkillResource(
          { DB: env.DB } as Bindings,
          threadId,
          personalId,
          1,
          "resources/missing.md",
        ),
      ),
    ).rejects.toBeInstanceOf(SkillResourceForbidden);
  });
});
