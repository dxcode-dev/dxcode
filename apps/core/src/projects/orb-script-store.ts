import {
  PROJECT_ORB_SCRIPT_KINDS,
  type Principal,
  type ProjectId,
  type ProjectOrbScriptKind,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer } from "effect";
import { projectPersistenceLogger } from "../logging.js";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

/**
 * A Project's Orb scripts in D1, shared by the settings routes
 * (`orb-scripts.ts`), the agent's `manage_dx` tool, and the one-time import
 * of the repository's files (`orb-script-import.ts`). Anyone who reaches the
 * Project reads them; changing one takes the right to manage the Project
 * (its creator or a workspace admin), and every change is audited.
 */

/**
 * SQL predicate on `?1` (the Project) and `?2` (the user): the user may
 * change the Project, as `projects/repository-d1.ts` decides for its other
 * settings.
 */
export const manageableSql = `EXISTS (
  SELECT 1 FROM projects AS project
   WHERE project.id = ?1
     AND ((project.workspace_id IS NULL AND project.owner_user_id = ?2)
       OR (project.workspace_id IS NOT NULL
         AND ${activeMemberSql("project.workspace_id", "?2")}
         AND (project.owner_user_id = ?2 OR EXISTS (
           SELECT 1 FROM member
            WHERE member.userId = ?2
              AND member.organizationId = project.workspace_id
              AND member.role IN ('owner', 'admin'))))))`;

export interface StoredOrbScript {
  readonly kind: ProjectOrbScriptKind;
  readonly body: string;
  readonly updatedAt: string;
}

export const readProjectOrbScripts = async (
  db: D1Database,
  projectId: string,
): Promise<ReadonlyArray<StoredOrbScript>> =>
  (
    await db
      .prepare(
        `SELECT kind, body, updated_at FROM project_orb_script
          WHERE project_id = ? AND kind IN (${PROJECT_ORB_SCRIPT_KINDS.map(() => "?").join(", ")})
          ORDER BY kind`,
      )
      .bind(projectId, ...PROJECT_ORB_SCRIPT_KINDS)
      .all<{ kind: ProjectOrbScriptKind; body: string; updated_at: string }>()
  ).results.map((row) => ({
    kind: row.kind,
    body: row.body,
    updatedAt: row.updated_at,
  }));

/** Whether the user may change the Project's scripts. */
export const canManageProject = async (
  db: D1Database,
  projectId: string,
  userId: string,
) =>
  (
    await db
      .prepare(`SELECT ${manageableSql} AS allowed`)
      .bind(projectId, userId)
      .first<{ allowed: number }>()
  )?.allowed === 1;

/** Whether the user reaches the Project, as its settings page does. */
export const projectReachable = async (
  db: D1Database,
  userId: string,
  projectId: ProjectId,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const principal: Principal = {
        userId: userId as Principal["userId"],
        credentialScopes: ["personal", "workspace"],
      };
      yield* (yield* ProjectService).get(principal, projectId);
      return true;
    }).pipe(
      Effect.catchTag("ProjectNotFound", () => Effect.succeed(false)),
      Effect.provide(
        ProjectService.layer.pipe(
          Layer.provide(
            ProjectRepositoryD1.pipe(Layer.provide(D1Client.layer({ db }))),
          ),
        ),
      ),
    ),
  );

export const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Saves (`body`) or clears (`undefined`) one script and records the change
 * in one transaction, both only while the user may manage the Project.
 * Answers false, changing nothing, when they may not.
 */
export const writeProjectOrbScript = async (
  db: D1Database,
  input: {
    readonly projectId: string;
    readonly kind: ProjectOrbScriptKind;
    readonly body: string | undefined;
    readonly userId: string;
    readonly requestId: string;
  },
) => {
  if (!(await canManageProject(db, input.projectId, input.userId)))
    return false;
  const now = new Date().toISOString();
  const digest = input.body === undefined ? null : await sha256Hex(input.body);
  const change =
    input.body === undefined
      ? db
          .prepare(
            `DELETE FROM project_orb_script
              WHERE project_id = ?1 AND kind = ?3 AND ${manageableSql}`,
          )
          .bind(input.projectId, input.userId, input.kind)
      : db
          .prepare(
            `INSERT INTO project_orb_script
               (project_id, kind, body, updated_by_user_id, updated_at)
             SELECT ?1, ?3, ?4, ?2, ?5 WHERE ${manageableSql}
             ON CONFLICT (project_id, kind) DO UPDATE SET
               body = excluded.body,
               updated_by_user_id = excluded.updated_by_user_id,
               updated_at = excluded.updated_at`,
          )
          .bind(input.projectId, input.userId, input.kind, input.body, now);
  const audit = db
    .prepare(
      `INSERT INTO project_orb_script_audit
         (id, project_id, kind, action, body_sha256, actor_user_id,
          request_id, occurred_at)
       SELECT ?3, ?1, ?4, ?5, ?6, ?2, ?7, ?8 WHERE ${manageableSql}`,
    )
    .bind(
      input.projectId,
      input.userId,
      crypto.randomUUID(),
      input.kind,
      input.body === undefined ? "clear" : "set",
      digest,
      input.requestId,
      now,
    );
  const [, recorded] = await db.batch([change, audit]);
  if ((recorded?.meta.changes ?? 0) !== 1) return false;
  projectPersistenceLogger.info("Project Orb script changed.", {
    event: "project_orb_script_change",
    projectId: input.projectId,
    kind: input.kind,
    action: input.body === undefined ? "clear" : "set",
    actorUserId: input.userId,
    requestId: input.requestId,
  });
  return true;
};
