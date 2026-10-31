import {
  GetProjectOrbScriptsResponseSchema,
  ProjectOrbScriptsForbiddenResponseSchema,
  ProjectOrbScriptsInvalidRequestResponseSchema,
  ProjectOrbScriptsNotFoundResponseSchema,
  ProjectOrbScriptsParamsSchema,
  ProjectOrbScriptsPersistenceUnavailableResponseSchema,
  UpdateProjectOrbScriptParamsSchema,
  UpdateProjectOrbScriptRequestSchema,
  UpdateProjectOrbScriptResponseSchema,
} from "@dx/api";
import {
  PersistenceUnavailable,
  PROJECT_ORB_SCRIPT_KINDS,
  type Principal,
  type ProjectId,
  type ProjectOrbScriptKind,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Match, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeLimitedJsonBody,
  decodeRequestInput,
} from "../http/request-decoding.js";
import type { AppEnv } from "../http/types.js";
import { projectPersistenceLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { activeMemberSql } from "../settings/members/membership-sql.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

/**
 * A Project's Orb scripts: saved in its settings and run in the Orb of every
 * Thread in it, so a repository works in Orbs without committing setup files.
 * Anyone who reaches the Project reads them; changing one takes the right to
 * manage the Project (its creator or a workspace admin), and every change is
 * audited. The agent has no tool to change them.
 */

class InvalidOrbScriptRequest extends Schema.TaggedError<InvalidOrbScriptRequest>()(
  "InvalidOrbScriptRequest",
  {},
) {}

class OrbScriptsManageRequired extends Schema.TaggedError<OrbScriptsManageRequired>()(
  "OrbScriptsManageRequired",
  {},
) {}

/** JSON escapes can grow a 32 KiB script up to six times. */
const MAX_REQUEST_BYTES = 256 * 1024;

const unavailable = (operation: string) => (cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

/**
 * SQL predicate on `?1` (the Project) and `?2` (the user): the user may
 * change the Project, as `projects/repository-d1.ts` decides for its other
 * settings.
 */
const manageableSql = `EXISTS (
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

interface ScriptRow {
  readonly kind: ProjectOrbScriptKind;
  readonly body: string;
  readonly updated_at: string;
}

const readScripts = (db: D1Database, projectId: ProjectId) =>
  Effect.tryPromise({
    try: async () =>
      (
        await db
          .prepare(
            `SELECT kind, body, updated_at FROM project_orb_script
              WHERE project_id = ? AND kind IN (${PROJECT_ORB_SCRIPT_KINDS.map(() => "?").join(", ")})
              ORDER BY kind`,
          )
          .bind(projectId, ...PROJECT_ORB_SCRIPT_KINDS)
          .all<ScriptRow>()
      ).results,
    catch: unavailable("project.orbScripts.read"),
  }).pipe(
    Effect.map((rows) => ({
      scripts: rows.map((row) => ({
        kind: row.kind,
        body: row.body,
        updatedAt: DateTime.makeUnsafe(row.updated_at),
      })),
    })),
  );

const sha256Hex = async (value: string) =>
  [
    ...new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  ]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

/**
 * Saves or clears one script and records the change in one transaction, both
 * only while the user may manage the Project.
 */
const writeScript = (
  db: D1Database,
  input: {
    readonly projectId: ProjectId;
    readonly kind: ProjectOrbScriptKind;
    readonly body: string | undefined;
    readonly userId: string;
    readonly requestId: string;
  },
) =>
  Effect.tryPromise({
    try: async () => {
      const allowed = await db
        .prepare(`SELECT ${manageableSql} AS allowed`)
        .bind(input.projectId, input.userId)
        .first<{ allowed: number }>();
      if (allowed?.allowed !== 1) return false;
      const now = new Date().toISOString();
      const digest =
        input.body === undefined ? null : await sha256Hex(input.body);
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
      return (recorded?.meta.changes ?? 0) === 1;
    },
    catch: unavailable("project.orbScripts.write"),
  }).pipe(
    Effect.flatMap((written) =>
      written ? Effect.void : Effect.fail(new OrbScriptsManageRequired()),
    ),
    Effect.tap(() =>
      Effect.sync(() =>
        projectPersistenceLogger.info("Project Orb script changed.", {
          event: "project_orb_script_change",
          projectId: input.projectId,
          kind: input.kind,
          action: input.body === undefined ? "clear" : "set",
          actorUserId: input.userId,
          requestId: input.requestId,
        }),
      ),
    ),
  );

/** The Project as the principal reaches it, or ProjectNotFound. */
const reachableProject = (
  db: D1Database,
  principal: Principal,
  projectId: ProjectId,
) =>
  Effect.gen(function* () {
    return yield* (yield* ProjectService).get(principal, projectId);
  }).pipe(
    Effect.provide(
      ProjectService.layer.pipe(
        Layer.provide(
          ProjectRepositoryD1.pipe(Layer.provide(D1Client.layer({ db }))),
        ),
      ),
    ),
  );

const errorBody = <const Code extends string, const Message extends string>(
  code: Code,
  message: Message,
  requestId: string,
) => ({ status: "error" as const, data: { code, message, requestId } });

export const projectOrbScriptRoutes = new Hono<AppEnv>();

const respond = async (
  context: Context<AppEnv>,
  operation: Effect.Effect<unknown, unknown>,
) => {
  const requestId = context.get("requestId");
  const result = await Effect.runPromise(Effect.result(operation));
  if (Result.isSuccess(result)) return context.json(result.success, 200);
  return Match.value(result.failure as { readonly _tag?: string }).pipe(
    Match.when({ _tag: "InvalidOrbScriptRequest" }, () =>
      context.json(
        Schema.encodeUnknownSync(ProjectOrbScriptsInvalidRequestResponseSchema)(
          errorBody("INVALID_REQUEST", "Request validation failed.", requestId),
        ),
        400,
      ),
    ),
    Match.when({ _tag: "ProjectNotFound" }, () =>
      context.json(
        Schema.encodeUnknownSync(ProjectOrbScriptsNotFoundResponseSchema)(
          errorBody("PROJECT_NOT_FOUND", "Project not found.", requestId),
        ),
        404,
      ),
    ),
    Match.when({ _tag: "OrbScriptsManageRequired" }, () =>
      context.json(
        Schema.encodeUnknownSync(ProjectOrbScriptsForbiddenResponseSchema)(
          errorBody(
            "PROJECT_MANAGE_REQUIRED",
            "Only the project's creator or a workspace admin can change its scripts.",
            requestId,
          ),
        ),
        403,
      ),
    ),
    Match.when({ _tag: "PersistenceUnavailable" }, () =>
      context.json(
        Schema.encodeUnknownSync(
          ProjectOrbScriptsPersistenceUnavailableResponseSchema,
        )(
          errorBody(
            "PERSISTENCE_UNAVAILABLE",
            "Persistence is temporarily unavailable.",
            requestId,
          ),
        ),
        503,
      ),
    ),
    Match.orElse(() => {
      throw result.failure;
    }),
  );
};

projectOrbScriptRoutes.get("/:projectId/orb-scripts", (context) =>
  respond(
    context,
    Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        ProjectOrbScriptsParamsSchema,
        { projectId: context.req.param("projectId") },
        () => new InvalidOrbScriptRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      yield* reachableProject(db, context.get("principal"), params.projectId);
      return yield* Schema.encodeUnknownEffect(
        GetProjectOrbScriptsResponseSchema,
      )({
        status: "success",
        data: yield* readScripts(db, params.projectId),
      });
    }),
  ),
);

projectOrbScriptRoutes.put("/:projectId/orb-scripts/:kind", (context) =>
  respond(
    context,
    Effect.gen(function* () {
      const params = yield* decodeRequestInput(
        UpdateProjectOrbScriptParamsSchema,
        {
          projectId: context.req.param("projectId"),
          kind: context.req.param("kind"),
        },
        () => new InvalidOrbScriptRequest(),
      );
      const input = yield* decodeLimitedJsonBody(
        context.req,
        MAX_REQUEST_BYTES,
        UpdateProjectOrbScriptRequestSchema,
        () => new InvalidOrbScriptRequest(),
      );
      const db = yield* decodeD1Binding(context.env.DB);
      const principal = context.get("principal");
      yield* reachableProject(db, principal, params.projectId);
      yield* writeScript(db, {
        projectId: params.projectId,
        kind: params.kind,
        body: input.body.trim() === "" ? undefined : input.body,
        userId: principal.userId,
        requestId: context.get("requestId"),
      });
      return yield* Schema.encodeUnknownEffect(
        UpdateProjectOrbScriptResponseSchema,
      )({
        status: "success",
        data: yield* readScripts(db, params.projectId),
      });
    }),
  ),
);
