import {
  SpaceCoordinatorOrbResponseSchema,
  UpdateSpaceCoordinatorOrbRequestSchema,
} from "@dx/api";
import {
  type Principal,
  type RunnerProfileId,
  WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { registeredSpaceCoordinatorDefault } from "../execution/deployment-orbs-registration.js";
import {
  loadRunnerProfileCatalog,
  selectRunnerProfile,
} from "../execution/runner-profiles/catalog.js";
import { readBoundedJson } from "../http/bounded-body.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { spaceLogger } from "../logging.js";
import { workspacePolicyLayer } from "../plugins/resolution.js";
import { SettingsService } from "../settings/service.js";

/**
 * The Orb a new Claude Code Space's coordinator (its main Thread) runs on
 * (wiki/runtime-architecture.md#execution-modes). A person chooses one in
 * Settings → Orb Providers, and so can their workspace's admins; when the
 * Space is created dx takes, in order:
 *
 * 1. the person's own choice;
 * 2. their workspace's;
 * 3. the deployment's default (`registeredSpaceCoordinatorDefault`), such
 *    as a size its admin picks; public dx has none;
 * 4. otherwise none: the Space is refused (`SPACE_ORB_UNAVAILABLE`).
 *
 * The coordinator's Thread pins the size at creation like any Thread, so
 * the account that pays follows the size: a person's or workspace's own
 * provider key bills that account, a size on the deployment's account
 * bills as the deployment bills its Orbs. A Space on a dx model needs no
 * Orb and ignores this.
 */

/** What the deployment runs a coordinator on when nobody chose an Orb. */
export type SpaceCoordinatorDefault =
  | { readonly kind: "orb"; readonly runnerProfileId: string }
  | { readonly kind: "executor" };

export type SpaceCoordinatorPlacement =
  | {
      readonly kind: "orb";
      readonly runnerProfileId: string;
      readonly source: "personal" | "workspace" | "deployment";
    }
  | { readonly kind: "executor" }
  | { readonly kind: "none" };

type Scope = "personal" | "workspace";

/** The message a refused Space shows: where to choose an Orb. */
export const SPACE_ORB_UNAVAILABLE_MESSAGE =
  "Spaces on Claude Code run their coordinator on an Orb. Choose one in Settings → Orb Providers → Space coordinator, or ask your workspace admin to choose one for the workspace.";

/**
 * Whether the Orb picker offers `runnerProfileId` now. A person or workspace
 * chooses only among offered sizes; a size the deployment keeps out of the
 * picker runs a coordinator only as the deployment's own default.
 */
const offered = (bindings: Bindings, runnerProfileId: RunnerProfileId) =>
  Effect.runPromise(
    loadRunnerProfileCatalog(bindings).pipe(
      Effect.flatMap((catalog) =>
        selectRunnerProfile(catalog, runnerProfileId),
      ),
      Effect.as(true),
      Effect.orElseSucceed(() => false),
    ),
  );

/** The person's and their workspace's choices, in one read. */
const loadChoices = async (db: D1Database, userId: string) => {
  const { results } = await db
    .prepare(
      `SELECT scope, runner_profile_id FROM space_coordinator_orb
        WHERE (scope = 'personal' AND target_id = ?1)
           OR (scope = 'workspace' AND target_id = (
                SELECT member.organizationId FROM member
                  JOIN organization ON organization.id = member.organizationId
                 WHERE member.userId = ?1
                   AND organization.lifecycleState = 'active'
                 LIMIT 1))`,
    )
    .bind(userId)
    .all<{ scope: Scope; runner_profile_id: string }>();
  const of = (scope: Scope) =>
    results.find((row) => row.scope === scope)?.runner_profile_id;
  return { personal: of("personal"), workspace: of("workspace") };
};

/** Where a new Claude Code Space of `userId`'s runs its coordinator now. */
export const resolveSpaceCoordinatorOrb = async (
  bindings: Bindings,
  userId: string,
): Promise<SpaceCoordinatorPlacement> => {
  const db = bindings.DB;
  if (db === undefined) return { kind: "none" };
  const choices = await loadChoices(db, userId);
  if (choices.personal !== undefined)
    return {
      kind: "orb",
      runnerProfileId: choices.personal,
      source: "personal",
    };
  if (choices.workspace !== undefined)
    return {
      kind: "orb",
      runnerProfileId: choices.workspace,
      source: "workspace",
    };
  const fallback = await registeredSpaceCoordinatorDefault(bindings, userId);
  if (fallback === undefined) return { kind: "none" };
  return fallback.kind === "executor"
    ? fallback
    : {
        kind: "orb",
        runnerProfileId: fallback.runnerProfileId,
        source: "deployment",
      };
};

const failure = (
  context: Context<AppEnv>,
  status: 400 | 403 | 404 | 503,
  code: string,
  message: string,
) =>
  context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") ?? "" },
    },
    status,
  );

interface Target {
  readonly scope: Scope;
  readonly targetId: string;
  readonly canUpdate: boolean;
}

/** The caller's workspace by its slug, and whether they may change it. */
const workspaceTarget = async (
  context: Context<AppEnv>,
  db: D1Database,
): Promise<Target | undefined> => {
  const slug = Schema.decodeUnknownOption(WorkspaceSlug)(
    context.req.param("workspaceSlug"),
  );
  if (Option.isNone(slug)) return undefined;
  const principal: Principal = context.get("principal");
  const access = await Effect.runPromise(
    Effect.gen(function* () {
      const settings = yield* SettingsService;
      return yield* settings.workspace(principal, slug.value);
    }).pipe(Effect.provide(workspacePolicyLayer(db)), Effect.option),
  );
  if (Option.isNone(access)) return undefined;
  return {
    scope: "workspace",
    targetId: access.value.workspace.workspace.id,
    canUpdate:
      access.value.workspace.workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(
        access.value.workspace.role,
        "workspace:update",
      ),
  };
};

const respond = async (
  context: Context<AppEnv>,
  db: D1Database,
  target: Target,
) => {
  const userId = context.get("principal").userId;
  const [row, effective] = await Promise.all([
    db
      .prepare(
        "SELECT runner_profile_id FROM space_coordinator_orb WHERE scope = ? AND target_id = ?",
      )
      .bind(target.scope, target.targetId)
      .first<{ runner_profile_id: string }>(),
    resolveSpaceCoordinatorOrb(context.env, userId),
  ]);
  return context.json(
    Schema.encodeUnknownSync(SpaceCoordinatorOrbResponseSchema)({
      status: "success",
      data: {
        runnerProfileId: row?.runner_profile_id ?? null,
        canUpdate: target.canUpdate,
        effective,
      },
    }),
    200,
  );
};

const routes = (
  target: (
    context: Context<AppEnv>,
    db: D1Database,
  ) => Promise<Target | undefined>,
) =>
  new Hono<AppEnv>()
    .get("/", async (context) => {
      const db = context.env.DB;
      if (db === undefined)
        return failure(
          context,
          503,
          "PERSISTENCE_UNAVAILABLE",
          "Persistence is temporarily unavailable.",
        );
      const resolved = await target(context, db);
      if (resolved === undefined)
        return failure(context, 404, "NOT_FOUND", "Workspace not found.");
      return respond(context, db, resolved);
    })
    .put("/", async (context) => {
      const db = context.env.DB;
      if (db === undefined)
        return failure(
          context,
          503,
          "PERSISTENCE_UNAVAILABLE",
          "Persistence is temporarily unavailable.",
        );
      const resolved = await target(context, db);
      if (resolved === undefined)
        return failure(context, 404, "NOT_FOUND", "Workspace not found.");
      if (!resolved.canUpdate)
        return failure(
          context,
          403,
          "FORBIDDEN",
          "Only the workspace's admins can choose its Space coordinator Orb.",
        );
      const body = Schema.decodeUnknownOption(
        UpdateSpaceCoordinatorOrbRequestSchema,
      )(await readBoundedJson(context.req.raw).catch(() => undefined));
      if (Option.isNone(body))
        return failure(
          context,
          400,
          "INVALID_REQUEST",
          "Choose an Orb size, or none.",
        );
      const runnerProfileId = body.value.runnerProfileId;
      if (
        runnerProfileId !== null &&
        !(await offered(context.env, runnerProfileId))
      )
        return failure(
          context,
          400,
          "INVALID_REQUEST",
          "Choose an Orb size the Orb picker offers, or none.",
        );
      if (runnerProfileId === null)
        await db
          .prepare(
            "DELETE FROM space_coordinator_orb WHERE scope = ? AND target_id = ?",
          )
          .bind(resolved.scope, resolved.targetId)
          .run();
      else
        await db
          .prepare(
            `INSERT INTO space_coordinator_orb
               (scope, target_id, runner_profile_id, updated_by, updated_at)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT (scope, target_id) DO UPDATE SET
               runner_profile_id = excluded.runner_profile_id,
               updated_by = excluded.updated_by,
               updated_at = excluded.updated_at`,
          )
          .bind(
            resolved.scope,
            resolved.targetId,
            runnerProfileId,
            context.get("principal").userId,
            new Date().toISOString(),
          )
          .run();
      spaceLogger.info("Space coordinator Orb saved.", {
        event: "space_coordinator_orb_saved",
        requestId: context.get("requestId"),
        scope: resolved.scope,
        cleared: runnerProfileId === null,
      });
      return respond(context, db, resolved);
    });

/** `/v1/settings/personal/space-coordinator-orb`. */
export const personalSpaceCoordinatorOrbRoutes = routes(async (context) => ({
  scope: "personal",
  targetId: context.get("principal").userId,
  canUpdate: true,
}));

/** `/v1/settings/workspaces/:workspaceSlug/space-coordinator-orb`. */
export const workspaceSpaceCoordinatorOrbRoutes = routes(workspaceTarget);
