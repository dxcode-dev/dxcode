import {
  PluginOrbResponseSchema,
  type PluginOrbSource,
  type PluginOrbStatus,
  UpdatePluginOrbRequestSchema,
} from "@dx/api";
import {
  type Principal,
  WorkspaceSlug,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { Effect, Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { registeredSpaceCoordinatorDefault } from "../../execution/deployment-orbs-registration.js";
import { readBoundedJson } from "../../http/bounded-body.js";
import type { AppEnv, Bindings } from "../../http/types.js";
import { SettingsService } from "../../settings/service.js";
import { workspacePolicyLayer } from "../resolution.js";
import { pluginServiceLogger } from "./log.js";
import { pluginOrbStoppedMessage } from "./payer.js";

/**
 * The Orb size plugins' services run on (wiki/plugin-platform-direction.md
 * "Plugin services"), chosen like the Space coordinator's
 * (spaces/coordinator-orb.ts): the plugin's own choice, then the person's,
 * then the workspace's, then the deployment's default. A workspace install
 * skips the person: a workspace's plugins never run on a size one member
 * chose for themself. With none, the service is refused
 * (`PLUGIN_ORB_UNAVAILABLE_MESSAGE`).
 *
 * The deployment's default is the Orb its admin chose for Space
 * coordinators (`registeredSpaceCoordinatorDefault`): one choice of a
 * small size dx starts on its own. Public dx registers none.
 */

export type PluginOrbChoice =
  | {
      readonly kind: "orb";
      readonly runnerProfileId: string;
      readonly source: PluginOrbSource;
    }
  | { readonly kind: "none" };

type ChoiceScope = "personal" | "workspace" | "plugin";

/** The plugin's, the person's, and the workspace's choices, in one read. */
const loadChoices = async (
  db: D1Database,
  input: {
    readonly pluginId: string | undefined;
    readonly userId: string | undefined;
    readonly workspaceId: string | undefined;
  },
) => {
  const { results } = await db
    .prepare(
      `SELECT scope, runner_profile_id FROM plugin_orb_choice
        WHERE (scope = 'plugin' AND target_id = ?1)
           OR (scope = 'personal' AND target_id = ?2)
           OR (scope = 'workspace' AND target_id = COALESCE(?3, (
                SELECT member.organizationId FROM member
                  JOIN organization ON organization.id = member.organizationId
                 WHERE member.userId = ?2
                   AND organization.lifecycleState = 'active'
                 LIMIT 1)))`,
    )
    .bind(
      input.pluginId ?? null,
      input.userId ?? null,
      input.workspaceId ?? null,
    )
    .all<{ scope: ChoiceScope; runner_profile_id: string }>();
  const of = (scope: ChoiceScope) =>
    results.find((row) => row.scope === scope)?.runner_profile_id;
  return {
    plugin: of("plugin"),
    personal: of("personal"),
    workspace: of("workspace"),
  };
};

/**
 * The size an install's service runs on now. `scope` and `targetId` are the
 * install's; `userId` is the person a personal install belongs to, or for a
 * workspace install the member who would pay (only the deployment default
 * reads it).
 */
export const resolvePluginOrbChoice = async (
  bindings: Bindings,
  input: {
    readonly scope: "personal" | "workspace";
    readonly targetId: string;
    readonly pluginId: string | undefined;
    readonly userId: string;
  },
): Promise<PluginOrbChoice> => {
  const db = bindings.DB;
  if (db === undefined) return { kind: "none" };
  const choices = await loadChoices(db, {
    pluginId: input.pluginId,
    userId: input.scope === "personal" ? input.targetId : undefined,
    workspaceId: input.scope === "workspace" ? input.targetId : undefined,
  });
  const chain: ReadonlyArray<readonly [string | undefined, PluginOrbSource]> = [
    [choices.plugin, "plugin"],
    ...(input.scope === "personal"
      ? [[choices.personal, "personal"] as const]
      : []),
    [choices.workspace, "workspace"],
  ];
  for (const [runnerProfileId, source] of chain)
    if (runnerProfileId !== undefined)
      return { kind: "orb", runnerProfileId, source };
  const fallback = await registeredSpaceCoordinatorDefault(
    bindings,
    input.userId,
  ).catch(() => undefined);
  return fallback?.kind === "orb"
    ? {
        kind: "orb",
        runnerProfileId: fallback.runnerProfileId,
        source: "deployment",
      }
    : { kind: "none" };
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
  readonly scope: ChoiceScope;
  readonly targetId: string;
  readonly canUpdate: boolean;
  /** Whose services the effective choice is resolved for. */
  readonly install: {
    readonly scope: "personal" | "workspace";
    readonly targetId: string;
    readonly pluginId: string | undefined;
  };
}

const canUpdateWorkspace = async (
  db: D1Database,
  workspaceId: string,
  userId: string,
) => {
  const row = await db
    .prepare(
      `SELECT member.role FROM member
         JOIN organization ON organization.id = member.organizationId
        WHERE member.organizationId = ? AND member.userId = ?
          AND organization.lifecycleState = 'active'`,
    )
    .bind(workspaceId, userId)
    .first<{ role: string }>();
  if (row === null) return undefined;
  return workspaceRoleHasPermission(
    row.role as Parameters<typeof workspaceRoleHasPermission>[0],
    "workspace:update",
  );
};

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
  const workspaceId = access.value.workspace.workspace.id;
  return {
    scope: "workspace",
    targetId: workspaceId,
    canUpdate:
      access.value.workspace.workspace.lifecycleState === "active" &&
      workspaceRoleHasPermission(
        access.value.workspace.role,
        "workspace:update",
      ),
    install: { scope: "workspace", targetId: workspaceId, pluginId: undefined },
  };
};

/** One install the caller can see: theirs, or their workspace's. */
const pluginTarget = async (
  context: Context<AppEnv>,
  db: D1Database,
): Promise<Target | undefined> => {
  const pluginId = context.req.param("pluginId");
  if (pluginId === undefined || pluginId.length > 128) return undefined;
  const userId = context.get("principal").userId;
  const install = await db
    .prepare(
      `SELECT scope, target_id FROM trusted_plugin
        WHERE id = ? AND kind = 'bundle' AND removed_at IS NULL`,
    )
    .bind(pluginId)
    .first<{ scope: "personal" | "workspace"; target_id: string }>();
  if (install === null) return undefined;
  const canUpdate =
    install.scope === "personal"
      ? install.target_id === userId
        ? true
        : undefined
      : await canUpdateWorkspace(db, install.target_id, userId);
  if (canUpdate === undefined) return undefined;
  return {
    scope: "plugin",
    targetId: pluginId,
    canUpdate,
    install: {
      scope: install.scope,
      targetId: install.target_id,
      pluginId,
    },
  };
};

/** The plugin Orb a target's services run on now, for "Runs on". */
const orbStatus = async (
  db: D1Database,
  target: Target,
  userId: string,
): Promise<PluginOrbStatus | undefined> => {
  const row = await db
    .prepare(
      `SELECT orb.id, orb.scope, orb.target_id, orb.runner_profile_id,
              orb.payer_user_id, orb.state, orb.stopped_reason,
              COALESCE(payer.name, payer.email, '') AS payer_name,
              (SELECT count(*) FROM plugin_service AS service
                WHERE service.orb_id = orb.id AND service.status <> 'off')
                AS services,
              (SELECT COALESCE(sum(session.ended_at - session.started_at), 0)
                 FROM thread_orb_session AS session
                WHERE session.thread_id = orb.id
                  AND session.owner_kind = 'plugin-orb'
                  AND session.started_at >= ?4) AS month_ms,
              (SELECT COALESCE(sum(session.cost_micros), 0)
                 FROM thread_orb_session AS session
                WHERE session.thread_id = orb.id
                  AND session.owner_kind = 'plugin-orb'
                  AND session.started_at >= ?4) AS month_cost
         FROM plugin_orb AS orb
         LEFT JOIN "user" AS payer ON payer.id = orb.payer_user_id
        WHERE ${
          target.scope === "plugin"
            ? `orb.id = (SELECT orb_id FROM plugin_service WHERE plugin_id = ?1)`
            : "orb.scope = ?2 AND orb.target_id = ?1 AND orb.plugin_id IS NULL AND orb.payer_user_id = ?3"
        }`,
    )
    .bind(
      target.targetId,
      target.scope,
      userId,
      Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), 1),
    )
    .first<{
      id: string;
      scope: "personal" | "workspace";
      target_id: string;
      runner_profile_id: string;
      payer_user_id: string;
      state: "active" | "stopped" | "removing";
      stopped_reason: string | null;
      payer_name: string;
      services: number;
      month_ms: number;
      month_cost: number;
    }>();
  if (row === null) return undefined;
  return {
    runnerProfileId:
      row.runner_profile_id as PluginOrbStatus["runnerProfileId"],
    payer: { userId: row.payer_user_id, name: row.payer_name },
    state: row.state,
    ...(row.stopped_reason === null
      ? {}
      : { stoppedReason: pluginOrbStoppedMessage(row.stopped_reason) }),
    services: row.services,
    month: {
      minutes: Math.round(row.month_ms / 60_000),
      costMicros: row.month_cost,
    },
  };
};

const respond = async (
  context: Context<AppEnv>,
  db: D1Database,
  target: Target,
) => {
  const userId = context.get("principal").userId;
  const [row, effective, orb] = await Promise.all([
    db
      .prepare(
        "SELECT runner_profile_id FROM plugin_orb_choice WHERE scope = ? AND target_id = ?",
      )
      .bind(target.scope, target.targetId)
      .first<{ runner_profile_id: string }>(),
    resolvePluginOrbChoice(context.env, { ...target.install, userId }),
    orbStatus(db, target, userId),
  ]);
  return context.json(
    Schema.encodeUnknownSync(PluginOrbResponseSchema)({
      status: "success",
      data: {
        runnerProfileId: row?.runner_profile_id ?? null,
        canUpdate: target.canUpdate,
        effective,
        ...(orb === undefined ? {} : { orb }),
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
        return failure(context, 404, "NOT_FOUND", "Not found.");
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
        return failure(context, 404, "NOT_FOUND", "Not found.");
      if (!resolved.canUpdate)
        return failure(
          context,
          403,
          "FORBIDDEN",
          "Only the workspace's admins can choose where its plugins run.",
        );
      const body = Schema.decodeUnknownOption(UpdatePluginOrbRequestSchema)(
        await readBoundedJson(context.req.raw).catch(() => undefined),
      );
      if (Option.isNone(body))
        return failure(
          context,
          400,
          "INVALID_REQUEST",
          "Choose an Orb size, or none.",
        );
      const runnerProfileId = body.value.runnerProfileId;
      if (runnerProfileId === null)
        await db
          .prepare(
            "DELETE FROM plugin_orb_choice WHERE scope = ? AND target_id = ?",
          )
          .bind(resolved.scope, resolved.targetId)
          .run();
      else
        await db
          .prepare(
            `INSERT INTO plugin_orb_choice
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
      pluginServiceLogger.info("Plugin Orb choice saved.", {
        event: "plugin_orb_choice_saved",
        requestId: context.get("requestId"),
        scope: resolved.scope,
        cleared: runnerProfileId === null,
      });
      return respond(context, db, resolved);
    });

/** `/v1/settings/personal/plugin-orb`. */
export const personalPluginOrbRoutes = routes(async (context) => {
  const userId = context.get("principal").userId;
  return {
    scope: "personal",
    targetId: userId,
    canUpdate: true,
    install: { scope: "personal", targetId: userId, pluginId: undefined },
  };
});

/** `/v1/settings/workspaces/:workspaceSlug/plugin-orb`. */
export const workspacePluginOrbRoutes = routes(workspaceTarget);

/** `/v1/settings/plugin-orb/plugins/:pluginId`. */
export const pluginPluginOrbRoutes = routes(pluginTarget);
