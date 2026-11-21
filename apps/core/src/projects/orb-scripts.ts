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
  type Principal,
  type ProjectId,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Match, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeLimitedJsonBody,
  decodeRequestInput,
} from "../http/request-decoding.js";
import type { AppEnv } from "../http/types.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import { ensureRepositoryOrbFilesImported } from "./orb-script-import.js";
import {
  canManageProject,
  readProjectOrbScripts,
  writeProjectOrbScript,
} from "./orb-script-store.js";
import { ProjectRepositoryD1 } from "./repository-d1.js";
import { ProjectService } from "./service.js";

/**
 * A Project's Orb scripts: saved in its settings and run in the Orb of every
 * Thread in it, in place of setup files committed to the repository. Anyone
 * who reaches the Project reads them; changing one takes the right to manage
 * the Project (its creator or a workspace admin), and every change is
 * audited. The agent changes them through `manage_dx` under the same rule.
 * The first read imports the repository's deprecated Orb files once
 * (`orb-script-import.ts`).
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

/** The saved scripts and whether the requester may change them. */
const readScripts = (db: D1Database, projectId: ProjectId, userId: string) =>
  Effect.tryPromise({
    try: () =>
      Promise.all([
        readProjectOrbScripts(db, projectId),
        canManageProject(db, projectId, userId),
      ]),
    catch: unavailable("project.orbScripts.read"),
  }).pipe(
    Effect.map(([scripts, canManage]) => ({
      scripts: scripts.map((script) => ({
        kind: script.kind,
        body: script.body,
        updatedAt: DateTime.makeUnsafe(script.updatedAt),
      })),
      canManage,
    })),
  );

const writeScript = (
  db: D1Database,
  input: Parameters<typeof writeProjectOrbScript>[1],
) =>
  Effect.tryPromise({
    try: () => writeProjectOrbScript(db, input),
    catch: unavailable("project.orbScripts.write"),
  }).pipe(
    Effect.flatMap((written) =>
      written ? Effect.void : Effect.fail(new OrbScriptsManageRequired()),
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

/** The one-time import of the repository's files; it never fails. */
const importRepositoryFiles = (
  context: Context<AppEnv>,
  db: D1Database,
  projectId: ProjectId,
) =>
  Effect.promise(() =>
    ensureRepositoryOrbFilesImported({
      db,
      bindings: context.env,
      projectId,
      userId: context.get("principal").userId,
      requestId: context.get("requestId"),
      waitUntil: (promise) => {
        // A request without an execution context (an in-process call) lets
        // the lease revocation run unawaited.
        try {
          context.executionCtx.waitUntil(promise);
        } catch {
          void promise;
        }
      },
    }),
  );

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
      const principal = context.get("principal");
      yield* reachableProject(db, principal, params.projectId);
      yield* importRepositoryFiles(context, db, params.projectId);
      return yield* Schema.encodeUnknownEffect(
        GetProjectOrbScriptsResponseSchema,
      )({
        status: "success",
        data: yield* readScripts(db, params.projectId, principal.userId),
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
      // Imported first, so the repository's file never fills a kind this
      // request clears.
      yield* importRepositoryFiles(context, db, params.projectId);
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
        data: yield* readScripts(db, params.projectId, principal.userId),
      });
    }),
  ),
);
