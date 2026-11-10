import {
  GetSpaceAgentModelResponseSchema,
  type SpaceAgentRoute,
  UpdateSpaceAgentModelRequestSchema,
} from "@dx/api";
import {
  CLAUDE_CODE_PROVIDER_ID,
  ClaudePlanRefused,
  claudeCodeModelFor,
  ModelNotServed,
  SPACE_AGENT_DEFAULT,
  SpaceAgentModel,
  type ThreadModelSelection,
  type UserId,
} from "@dx/domain";
import { Option, Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { spaceLogger } from "../logging.js";
import { findCatalogModel } from "../settings/model-routing/catalog.js";
import { loadRoutableConnections } from "../settings/model-routing/connection-store-d1.js";
import { resolveSelectionForUser } from "../settings/model-routing/submission.js";

/**
 * The model a person's new Spaces run on, and the route a new Space takes
 * (wiki/runtime-architecture.md#execution-modes). A Space's main Thread runs
 * in executor mode, with no Orb. When the Space is created dx picks its
 * route once, and the Space keeps it:
 *
 * 1. the model is one Claude Code serves and the person has a Claude Pro/Max
 *    plan connected: Claude Code, in the Space's executor;
 * 2. otherwise Model Routing serves the model: dx's own agent, in its
 *    Durable Object, with no container;
 * 3. otherwise the Space is not created (`SPACE_MODEL_UNAVAILABLE`), and the
 *    person picks another model or connects a provider.
 *
 * A Space on Claude Code never falls back: a lost plan or a used-up limit
 * fails its turns with Claude Code's own errors, as any Claude Code Thread.
 */

type Pin = typeof SpaceAgentModel.Type;

export const loadSpaceAgentModel = async (
  db: D1Database,
  userId: string,
): Promise<Pin | undefined> => {
  const row = await db
    .prepare("SELECT model, thinking FROM space_agent_model WHERE user_id = ?")
    .bind(userId)
    .first<{ model: string; thinking: string }>();
  if (row === null) return undefined;
  return Option.getOrUndefined(
    Schema.decodeUnknownOption(SpaceAgentModel)(row),
  );
};

const modelName = (canonical: string) => {
  const slash = canonical.indexOf("/");
  return (
    findCatalogModel(canonical.slice(0, slash), canonical.slice(slash + 1))
      ?.name ?? canonical
  );
};

/** A new Space's route, and what its Thread is created with. */
export interface SpaceAgentResolution {
  readonly route: SpaceAgentRoute;
  readonly creation?: {
    readonly selection: ThreadModelSelection;
    readonly claudeConnectionId?: string;
  };
}

/** A plan the person picked for their new Space cannot serve it. */
export class SpacePlanRefused extends Error {}

/**
 * Where a new Space of `userId`'s would run now. Each step asks Model
 * Routing exactly as a new Thread's creation does, so the answer is the one
 * the Space's Thread is created with. `claudeConnectionId` is the plan the
 * person picked, as a new Thread's plan list picks one; it applies only when
 * the Space runs on Claude Code, and a picked plan that cannot serve throws
 * `SpacePlanRefused` instead of moving the Space to another plan.
 */
export const resolveSpaceAgentRoute = async (
  bindings: Bindings,
  userId: UserId,
  claudeConnectionId?: string,
): Promise<SpaceAgentResolution> => {
  const db = bindings.DB;
  if (db === undefined) throw new Error("Model routing is not configured.");
  const effective: Pin = (await loadSpaceAgentModel(db, userId)) ?? {
    model: SPACE_AGENT_DEFAULT.model as Pin["model"],
    thinking: SPACE_AGENT_DEFAULT.thinking,
  };
  const thinking = effective.thinking;
  const claudeCode = claudeCodeModelFor(effective.model);
  if (claudeCode !== undefined) {
    const plans = (await loadRoutableConnections(db, userId)).filter(
      ({ providerId, enabled }) =>
        providerId === CLAUDE_CODE_PROVIDER_ID && enabled,
    );
    if (plans.length > 0) {
      const selection = {
        kind: "model",
        model: claudeCode,
        thinking,
      } as unknown as ThreadModelSelection;
      const attempt = async (claudeConnectionId?: string) =>
        resolveSelectionForUser(
          bindings,
          userId,
          selection,
          claudeConnectionId,
        );
      if (claudeConnectionId !== undefined) {
        try {
          const resolved = await attempt(claudeConnectionId);
          const connectionId =
            resolved.claudeConnectionId ?? claudeConnectionId;
          return {
            route: {
              kind: "claude-code",
              model: claudeCode as never,
              modelName: modelName(claudeCode),
              thinking,
              connectionName:
                plans.find(({ id }) => id === connectionId)?.name ??
                resolved.connection.name,
            },
            creation: { selection, claudeConnectionId: connectionId },
          };
        } catch (error) {
          if (error instanceof ClaudePlanRefused)
            throw new SpacePlanRefused(error.message);
          throw error;
        }
      }
      try {
        let resolved: Awaited<ReturnType<typeof attempt>>;
        try {
          resolved = await attempt();
        } catch (error) {
          // Several plans and no automatic pick: a Space takes the first.
          if (
            !(error instanceof ClaudePlanRefused && error.reason === "required")
          )
            throw error;
          resolved = await attempt(plans[0]?.id);
        }
        const connectionId = resolved.claudeConnectionId ?? plans[0]?.id;
        return {
          route: {
            kind: "claude-code",
            model: claudeCode as never,
            modelName: modelName(claudeCode),
            thinking,
            connectionName:
              plans.find(({ id }) => id === connectionId)?.name ??
              resolved.connection.name,
          },
          creation: {
            selection,
            ...(connectionId === undefined
              ? {}
              : { claudeConnectionId: connectionId }),
          },
        };
      } catch (error) {
        // The person has a plan: their Space is bound to Claude Code, and
        // a plan that cannot serve now says why instead of falling back.
        if (error instanceof ClaudePlanRefused)
          return {
            route: {
              kind: "unavailable",
              model: claudeCode as never,
              modelName: modelName(claudeCode),
              thinking,
              message: error.message,
            },
          };
        if (!(error instanceof ModelNotServed)) throw error;
      }
    }
  }
  const selection = {
    kind: "model",
    model: effective.model,
    thinking,
  } as unknown as ThreadModelSelection;
  try {
    const resolved = await resolveSelectionForUser(bindings, userId, selection);
    return {
      route: {
        kind: "model-routing",
        model: effective.model,
        modelName: modelName(effective.model),
        thinking,
        connectionName: resolved.connection.name,
      },
      creation: { selection },
    };
  } catch (error) {
    if (!(error instanceof ModelNotServed)) throw error;
    return {
      route: {
        kind: "unavailable",
        model: effective.model,
        modelName: modelName(effective.model),
        thinking,
        message: `No connection serves ${modelName(effective.model)}. Connect a Claude Pro/Max plan or a provider that serves it in Model Routing, or pick another model for Spaces in Mode Dial.`,
      },
    };
  }
};

const respond = async (bindings: Bindings, db: D1Database, userId: UserId) => {
  const [pin, resolution] = await Promise.all([
    loadSpaceAgentModel(db, userId),
    resolveSpaceAgentRoute(bindings, userId),
  ]);
  return Schema.encodeUnknownSync(GetSpaceAgentModelResponseSchema)({
    status: "success",
    data: {
      ...(pin === undefined ? {} : { pin }),
      route: resolution.route,
    },
  });
};

const failure = (
  context: { readonly json: (body: unknown, status: number) => Response },
  requestId: string,
  status: number,
  code: string,
  message: string,
) =>
  context.json(
    { status: "error", data: { code, message, requestId } },
    status as never,
  );

/** `/v1/settings/personal/space-agent-model`: Settings → Mode Dial → Space. */
export const spaceAgentModelRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(
        context,
        context.get("requestId"),
        503,
        "PERSISTENCE_UNAVAILABLE",
        "Persistence is temporarily unavailable.",
      );
    const userId = context.get("principal").userId as UserId;
    return context.json(await respond(context.env, db, userId), 200);
  })
  .put("/", async (context) => {
    const db = context.env.DB;
    if (db === undefined)
      return failure(
        context,
        context.get("requestId"),
        503,
        "PERSISTENCE_UNAVAILABLE",
        "Persistence is temporarily unavailable.",
      );
    const body = Schema.decodeUnknownOption(UpdateSpaceAgentModelRequestSchema)(
      await context.req.json().catch(() => undefined),
    );
    if (Option.isNone(body))
      return failure(
        context,
        context.get("requestId"),
        400,
        "INVALID_REQUEST",
        "Request validation failed.",
      );
    const userId = context.get("principal").userId as UserId;
    const pin = body.value.pin;
    if (pin === null)
      await db
        .prepare("DELETE FROM space_agent_model WHERE user_id = ?")
        .bind(userId)
        .run();
    else
      await db
        .prepare(
          `INSERT INTO space_agent_model (user_id, model, thinking, updated_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT (user_id) DO UPDATE SET
             model = excluded.model, thinking = excluded.thinking,
             updated_at = excluded.updated_at`,
        )
        .bind(userId, pin.model, pin.thinking, new Date().toISOString())
        .run();
    spaceLogger.info("Space agent model saved.", {
      event: "space_agent_model_saved",
      requestId: context.get("requestId"),
      auto: pin === null,
    });
    return context.json(await respond(context.env, db, userId), 200);
  });
