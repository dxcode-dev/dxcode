import {
  CatalogResponseSchema,
  ChoicesResponseSchema,
  ConnectionResponseSchema,
  CreateConnectionRequestSchema,
  DeleteConnectionResponseSchema,
  GraphResponseSchema,
  ListConnectionsResponseSchema,
  ModelConnectionNotFoundResponseSchema,
  ModelRoutingForbiddenResponseSchema,
  ModelRoutingInvalidRequestResponseSchema,
  ModelRoutingMutationForbiddenResponseSchema,
  ModelRoutingUnavailableResponseSchema,
  ProfileResponseSchema,
  PutModeRequestSchema,
  ReorderConnectionsRequestSchema,
  ReorderConnectionsResponseSchema,
  SetConnectionEnabledRequestSchema,
  UpdateConnectionRequestSchema,
  WorkspaceModelRoutingParamsSchema,
} from "@dx/api";
import {
  ModeId,
  type ModelConnectionTarget,
  SettingsScopeForbidden,
  type StoredModelConnection,
  Timestamp,
  workspaceRoleHasPermission,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv, Bindings } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import {
  DEV_PROFILE,
  devWorkersAiConnection,
  workersAiDeploymentEnabled,
} from "../../runtime/model-routing-dev-defaults.js";
import { loadConfigEncryptionKeyring } from "../config-encryption.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import {
  ModelConnectionNotFoundError,
  ModelRoutingService,
  ModelRoutingValidationError,
} from "./service.js";

const respond = (schema: Schema.ConstraintEncoder<unknown>, data: unknown) =>
  Schema.encodeUnknownSync(schema)({ status: "success", data });

class MutationForbidden extends Error {}
class ModelRoutingUnavailableError extends Error {}

const failure = (c: Context<AppEnv>, error: unknown): Response => {
  const requestId = c.get("requestId");
  if (error instanceof ModelRoutingValidationError) {
    return c.json(
      Schema.encodeUnknownSync(ModelRoutingInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_MODEL_ROUTING_REQUEST",
          message: "Model routing validation failed.",
          requestId,
          fieldErrors: error.fieldErrors,
        },
      }),
      400,
    );
  }
  if (error instanceof ModelConnectionNotFoundError) {
    return c.json(
      Schema.encodeUnknownSync(ModelConnectionNotFoundResponseSchema)({
        status: "error",
        data: {
          code: "MODEL_CONNECTION_NOT_FOUND",
          message: "Model connection not found.",
          requestId,
        },
      }),
      404,
    );
  }
  if (error instanceof MutationForbidden) {
    return c.json(
      Schema.encodeUnknownSync(ModelRoutingMutationForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "MODEL_ROUTING_MUTATION_FORBIDDEN",
          message: "This workspace role has read-only model routing access.",
          requestId,
        },
      }),
      403,
    );
  }
  if (error instanceof SettingsScopeForbidden) {
    return c.json(
      Schema.encodeUnknownSync(ModelRoutingForbiddenResponseSchema)({
        status: "error",
        data: {
          code: "SETTINGS_SCOPE_FORBIDDEN",
          message: "The settings scope is unavailable for this user.",
          requestId,
        },
      }),
      403,
    );
  }
  return c.json(
    Schema.encodeUnknownSync(ModelRoutingUnavailableResponseSchema)({
      status: "error",
      data: {
        code: "MODEL_ROUTING_UNAVAILABLE",
        message: "Model routing is not configured.",
        requestId,
      },
    }),
    503,
  );
};

interface Deps {
  readonly service: ModelRoutingService;
  readonly checkAccess: (
    target: ModelConnectionTarget,
    connectionId: string,
  ) => Promise<StoredModelConnection["health"]>;
}

const checkAccessProbe =
  (env: Bindings): Deps["checkAccess"] =>
  async (target, connectionId) => {
    const namespace = env.BYOK_CREDENTIAL_COORDINATOR;
    if (namespace === undefined) throw new ModelRoutingUnavailableError();
    const name = `check-${target.scope}-${target.id}-${connectionId}`;
    const response = await namespace
      .get(namespace.idFromName(name))
      .fetch("https://dx-byok.invalid/check", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target: { scope: target.scope, id: target.id },
          connectionId,
        }),
      });
    if (!response.ok) throw new ModelRoutingUnavailableError();
    const body = (await response.json()) as {
      health: StoredModelConnection["health"];
    };
    return body.health;
  };

const dependencies = async (c: Context<AppEnv>): Promise<Deps> => {
  const db = await Effect.runPromise(decodeD1Binding(c.env.DB));
  const keyring = await Effect.runPromise(loadConfigEncryptionKeyring(c.env));
  const workersAiEnabled = workersAiDeploymentEnabled(c.env);
  return {
    service: new ModelRoutingService(
      db,
      keyring,
      workersAiEnabled ? DEV_PROFILE : undefined,
      workersAiEnabled
        ? [
            devWorkersAiConnection(
              Schema.decodeUnknownSync(Timestamp)(new Date().toISOString()),
            ),
          ]
        : undefined,
      c.env.DX_MODEL_ENDPOINT_ALLOWLIST,
      c.env.DX_MODEL_DEPLOYMENT_PROVIDERS,
    ),
    checkAccess: checkAccessProbe(c.env),
  };
};

interface ResolvedTarget {
  readonly target: ModelConnectionTarget;
  readonly canMutate: boolean;
}

const personalTarget = (c: Context<AppEnv>): ResolvedTarget => ({
  target: { scope: "personal", id: c.get("principal").userId },
  canMutate: true,
});

const workspaceTarget = async (c: Context<AppEnv>): Promise<ResolvedTarget> => {
  const { workspaceSlug } = Schema.decodeUnknownSync(
    WorkspaceModelRoutingParamsSchema,
  )({ workspaceSlug: c.req.param("workspaceSlug") });
  const db = await Effect.runPromise(decodeD1Binding(c.env.DB));
  const access = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const settings = yield* SettingsService;
        return yield* settings.workspace(c.get("principal"), workspaceSlug);
      }).pipe(
        Effect.provide(
          SettingsService.layer.pipe(
            Layer.provide(
              WorkspaceRepositoryD1(db).pipe(
                Layer.provide(D1Client.layer({ db })),
              ),
            ),
          ),
        ),
      ),
    ),
  );
  if (Result.isFailure(access)) throw access.failure;
  const workspace = access.success.workspace;
  return {
    target: { scope: "workspace", id: workspace.workspace.id },
    canMutate: workspaceRoleHasPermission(workspace.role, "workspace:update"),
  };
};

const decodeBody = async <A>(
  c: Context<AppEnv>,
  schema: Schema.Codec<A, unknown>,
): Promise<A> => {
  try {
    const body = await c.req.json();
    return Schema.decodeUnknownSync(schema)(body);
  } catch {
    throw new ModelRoutingValidationError([
      { field: "body", message: "Request body is invalid." },
    ]);
  }
};

const handle = async (
  c: Context<AppEnv>,
  run: () => Promise<Response>,
): Promise<Response> => {
  try {
    return await run();
  } catch (error) {
    return failure(c, error);
  }
};

/** Connection CRUD shared by personal and workspace mounts. */
const mountConnectionRoutes = (
  app: Hono<AppEnv>,
  resolveTarget: (c: Context<AppEnv>) => Promise<ResolvedTarget>,
) => {
  app.get("/connections", (c) =>
    handle(c, async () => {
      const { target } = await resolveTarget(c);
      const deps = await dependencies(c);
      return c.json(
        respond(ListConnectionsResponseSchema, {
          connections: await deps.service.listConnections(target),
        }),
        200,
      );
    }),
  );

  app.post("/connections", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const input = await decodeBody(c, CreateConnectionRequestSchema);
      const deps = await dependencies(c);
      return c.json(
        respond(
          ConnectionResponseSchema,
          await deps.service.createConnection(target, input),
        ),
        200,
      );
    }),
  );

  app.patch("/connections/:connectionId", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const input = await decodeBody(c, UpdateConnectionRequestSchema);
      const deps = await dependencies(c);
      return c.json(
        respond(
          ConnectionResponseSchema,
          await deps.service.updateConnection(
            target,
            c.req.param("connectionId"),
            input,
          ),
        ),
        200,
      );
    }),
  );

  app.post("/connections/:connectionId/enabled", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const input = await decodeBody(c, SetConnectionEnabledRequestSchema);
      const deps = await dependencies(c);
      return c.json(
        respond(
          ConnectionResponseSchema,
          await deps.service.setEnabled(
            target,
            c.req.param("connectionId"),
            input.enabled,
          ),
        ),
        200,
      );
    }),
  );

  app.post("/connections/reorder", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const input = await decodeBody(c, ReorderConnectionsRequestSchema);
      const deps = await dependencies(c);
      return c.json(
        respond(ReorderConnectionsResponseSchema, {
          connections: await deps.service.reorderConnections(
            target,
            input.orderedIds,
          ),
        }),
        200,
      );
    }),
  );

  app.post("/connections/:connectionId/check-access", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const deps = await dependencies(c);
      return c.json(
        respond(
          ConnectionResponseSchema,
          await deps.service.checkAccess(
            target,
            c.req.param("connectionId"),
            deps.checkAccess,
          ),
        ),
        200,
      );
    }),
  );

  app.delete("/connections/:connectionId", (c) =>
    handle(c, async () => {
      const { target, canMutate } = await resolveTarget(c);
      if (!canMutate) throw new MutationForbidden();
      const deps = await dependencies(c);
      const connectionId = c.req.param("connectionId");
      await deps.service.removeConnection(target, connectionId);
      return c.json(
        respond(DeleteConnectionResponseSchema, {
          deletedConnectionId: connectionId,
        }),
        200,
      );
    }),
  );
};

// Personal -------------------------------------------------------------------

export const personalModelRoutingRoutes = new Hono<AppEnv>();
mountConnectionRoutes(personalModelRoutingRoutes, async (c) =>
  personalTarget(c),
);

personalModelRoutingRoutes.get("/catalog", (c) =>
  handle(c, async () => {
    const deps = await dependencies(c);
    return c.json(respond(CatalogResponseSchema, deps.service.catalog()), 200);
  }),
);

personalModelRoutingRoutes.get("/graph", (c) =>
  handle(c, async () => {
    const deps = await dependencies(c);
    return c.json(
      respond(
        GraphResponseSchema,
        await deps.service.graph(c.get("principal").userId),
      ),
      200,
    );
  }),
);

personalModelRoutingRoutes.get("/choices", (c) =>
  handle(c, async () => {
    const deps = await dependencies(c);
    return c.json(
      respond(
        ChoicesResponseSchema,
        await deps.service.choices(c.get("principal").userId),
      ),
      200,
    );
  }),
);

personalModelRoutingRoutes.get("/profile", (c) =>
  handle(c, async () => {
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.profile(c.get("principal").userId),
      ),
      200,
    );
  }),
);

personalModelRoutingRoutes.put("/profile/modes/:mode", (c) =>
  handle(c, async () => {
    let mode: typeof ModeId.Type;
    try {
      mode = Schema.decodeUnknownSync(ModeId)(c.req.param("mode"));
    } catch {
      throw new ModelRoutingValidationError([
        { field: "mode", message: "Mode must be low, medium, high, or ultra." },
      ]);
    }
    const config = await decodeBody(c, PutModeRequestSchema);
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.putMode(c.get("principal").userId, mode, config),
      ),
      200,
    );
  }),
);

personalModelRoutingRoutes.delete("/profile/modes/:mode", (c) =>
  handle(c, async () => {
    let mode: typeof ModeId.Type;
    try {
      mode = Schema.decodeUnknownSync(ModeId)(c.req.param("mode"));
    } catch {
      throw new ModelRoutingValidationError([
        { field: "mode", message: "Mode must be low, medium, high, or ultra." },
      ]);
    }
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.resetMode(c.get("principal").userId, mode),
      ),
      200,
    );
  }),
);

// Workspace ------------------------------------------------------------------

export const workspaceModelRoutingRoutes = new Hono<AppEnv>();
mountConnectionRoutes(workspaceModelRoutingRoutes, workspaceTarget);

workspaceModelRoutingRoutes.get("/catalog", (c) =>
  handle(c, async () => {
    await workspaceTarget(c);
    const deps = await dependencies(c);
    return c.json(
      respond(
        CatalogResponseSchema,
        deps.service.catalog({ includeSubscriptions: false }),
      ),
      200,
    );
  }),
);

workspaceModelRoutingRoutes.get("/graph", (c) =>
  handle(c, async () => {
    const { target } = await workspaceTarget(c);
    const deps = await dependencies(c);
    return c.json(
      respond(
        GraphResponseSchema,
        await deps.service.graph(c.get("principal").userId, target),
      ),
      200,
    );
  }),
);

const modeParam = (c: Context<AppEnv>) => {
  try {
    return Schema.decodeUnknownSync(ModeId)(c.req.param("mode"));
  } catch {
    throw new ModelRoutingValidationError([
      { field: "mode", message: "Mode must be low, medium, high, or ultra." },
    ]);
  }
};

// Models the workspace's own connections serve, for the workspace Mode Dial.
workspaceModelRoutingRoutes.get("/choices", (c) =>
  handle(c, async () => {
    const { target } = await workspaceTarget(c);
    const deps = await dependencies(c);
    return c.json(
      respond(
        ChoicesResponseSchema,
        await deps.service.choices(c.get("principal").userId, target),
      ),
      200,
    );
  }),
);

// Workspace Mode Dial: applies to members who have not set that mode in
// their personal Mode Dial. Only admins change it.
workspaceModelRoutingRoutes.get("/profile", (c) =>
  handle(c, async () => {
    const { target } = await workspaceTarget(c);
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.workspaceProfile(
          c.get("principal").userId,
          target.id,
        ),
      ),
      200,
    );
  }),
);

workspaceModelRoutingRoutes.put("/profile/modes/:mode", (c) =>
  handle(c, async () => {
    const { target, canMutate } = await workspaceTarget(c);
    if (!canMutate) throw new MutationForbidden();
    const mode = modeParam(c);
    const config = await decodeBody(c, PutModeRequestSchema);
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.putWorkspaceMode(
          c.get("principal").userId,
          target.id,
          mode,
          config,
        ),
      ),
      200,
    );
  }),
);

workspaceModelRoutingRoutes.delete("/profile/modes/:mode", (c) =>
  handle(c, async () => {
    const { target, canMutate } = await workspaceTarget(c);
    if (!canMutate) throw new MutationForbidden();
    const mode = modeParam(c);
    const deps = await dependencies(c);
    return c.json(
      respond(
        ProfileResponseSchema,
        await deps.service.resetWorkspaceMode(
          c.get("principal").userId,
          target.id,
          mode,
        ),
      ),
      200,
    );
  }),
);
