import {
  CreatePluginTriggerRequestSchema,
  CreatePluginTriggerResponseSchema,
  ListPluginTriggersResponseSchema,
  type PluginTriggerData,
  PluginTriggerConflictResponseSchema,
  PluginTriggerDeliveryParamsSchema,
  PluginTriggerForbiddenResponseSchema,
  PluginTriggerLimitResponseSchema,
  PluginTriggerNotFoundResponseSchema,
  PluginTriggerParamsSchema,
  PluginTriggersPolicyDeniedResponseSchema,
  PluginTriggersBrowserSessionRequiredResponseSchema,
  PluginTriggersInvalidRequestResponseSchema,
  PluginTriggersUnavailableResponseSchema,
  PluginTriggerWebhookHeadersSchema,
  PluginTriggerWebhookPayloadSchema,
  RetryPluginTriggerDeliveryResponseSchema,
  RevokePluginTriggerResponseSchema,
  RotatePluginTriggerResponseSchema,
  type SettingsFieldError,
  UpdatePluginTriggerStateRequestSchema,
  UpdatePluginTriggerStateResponseSchema,
} from "@dx/api";
import {
  EnvironmentVariableRepository,
  MAX_TRIGGER_PAYLOAD_BYTES,
  PersistenceUnavailable,
  PluginTriggerCapability,
  PluginTriggerCapabilityForbidden,
  PluginTriggerConflict,
  PluginTriggerDeliverySummary,
  PluginTriggerId,
  PluginTriggerLimitExceeded,
  PluginTriggerNotFound,
  PluginTriggerRepository,
  TRIGGER_REPLAY_WINDOW_MS,
  type StoredPluginTrigger,
  WorkspacePolicyDenied,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { DateTime, Effect, Layer, Option, Result, Schema } from "effect";
import { type Context, Hono } from "hono";
import {
  decodeJsonBody,
  decodeRequestInput,
} from "../../http/request-decoding.js";
import type { AppEnv } from "../../http/types.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import { SettingsAudit } from "../audit.js";
import {
  decryptEnvironmentVariable,
  loadConfigEncryptionKeyring,
} from "../environment-variables/encryption.js";
import { EnvironmentVariableRepositoryD1 } from "../environment-variables/repository-d1.js";
import { PluginRepositoryD1 } from "../plugins/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { PluginTriggerRepositoryD1 } from "./repository-d1.js";
import {
  capabilityHashesEqual,
  hashPluginTriggerCapability,
  PluginTriggerService,
} from "./service.js";

class InvalidTriggerRequest extends Schema.TaggedError<InvalidTriggerRequest>()(
  "InvalidTriggerRequest",
  {
    fieldErrors: Schema.Array(
      Schema.Struct({ field: Schema.String, message: Schema.String }),
    ),
  },
) {}

class BrowserSessionRequired extends Schema.TaggedError<BrowserSessionRequired>()(
  "BrowserSessionRequired",
  {},
) {}

class TriggerDeliveryUnavailable extends Schema.TaggedError<TriggerDeliveryUnavailable>()(
  "TriggerDeliveryUnavailable",
  {},
) {}

interface DurableStatus {
  readonly deliverySummary: typeof PluginTriggerDeliverySummary.Type;
  readonly deliveries: PluginTriggerData["deliveries"];
}

const emptyStatus: DurableStatus = {
  deliverySummary: {
    pending: 0,
    inFlight: 0,
    succeeded: 0,
    deadLetter: 0,
    cancelled: 0,
  },
  deliveries: [],
};

const fieldError = (field: string, message: string): SettingsFieldError => ({
  field,
  message,
});

const invalid = (field: string, message: string) =>
  new InvalidTriggerRequest({ fieldErrors: [fieldError(field, message)] });

const layers = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const triggers = PluginTriggerRepositoryD1(db);
  const plugins = PluginRepositoryD1(db);
  const environment = EnvironmentVariableRepositoryD1(db);
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  const policy = WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
  const service = PluginTriggerService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        triggers,
        plugins,
        environment,
        policy,
        SettingsAudit.layer,
      ),
    ),
  );
  return Layer.mergeAll(
    triggers,
    plugins,
    environment,
    workspace,
    settings,
    policy,
    service,
  );
};

const triggerStub = (context: Context<AppEnv>, triggerId: string) => {
  const namespace = context.env.PLUGIN_TRIGGER_DELIVERY;
  if (namespace === undefined) throw new TriggerDeliveryUnavailable();
  return namespace.get(namespace.idFromName(triggerId));
};

const durableFetch = Effect.fn("pluginTriggerDurableFetch")(function* (
  context: Context<AppEnv>,
  triggerId: string,
  path: string,
  init?: RequestInit,
) {
  const response = yield* Effect.tryPromise({
    try: () =>
      triggerStub(context, triggerId).fetch(
        `https://trigger.invalid${path}`,
        init,
      ),
    catch: () => new TriggerDeliveryUnavailable(),
  });
  const body = yield* Effect.tryPromise({
    try: () => response.json() as Promise<unknown>,
    catch: () => new TriggerDeliveryUnavailable(),
  });
  return { response, body };
});

const durableStatus = Effect.fn("pluginTriggerDurableStatus")(function* (
  context: Context<AppEnv>,
  triggerId: string,
) {
  const { response, body } = yield* durableFetch(context, triggerId, "/status");
  if (!response.ok) return yield* new TriggerDeliveryUnavailable();
  return yield* Schema.decodeUnknownEffect(
    Schema.Struct({
      deliverySummary: PluginTriggerDeliverySummary,
      deliveries: Schema.Array(
        Schema.Struct({
          id: Schema.String,
          eventId: Schema.String,
          status: Schema.String,
          attempts: Schema.Int,
          idempotent: Schema.Boolean,
          createdAt: Schema.String,
          updatedAt: Schema.String,
          nextAttemptAt: Schema.optional(Schema.String),
          failureCode: Schema.optional(Schema.String),
        }),
      ),
    }),
  )(body).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(
        Schema.Struct({
          deliverySummary: PluginTriggerDeliverySummary,
          deliveries: Schema.Array(
            Schema.Struct({
              id: Schema.String,
              eventId: Schema.String,
              status: Schema.String,
              attempts: Schema.Int,
              idempotent: Schema.Boolean,
              createdAt: Schema.String,
              updatedAt: Schema.String,
              nextAttemptAt: Schema.optional(Schema.String),
              failureCode: Schema.optional(Schema.String),
            }),
          ),
        }),
      )(value),
    ),
    Effect.map((value) => value as unknown as DurableStatus),
    Effect.mapError(() => new TriggerDeliveryUnavailable()),
  );
});

const triggerData = (
  trigger: StoredPluginTrigger,
  available: ReadonlyArray<
    typeof import("@dx/api").TriggerPluginCapabilityDataSchema.Type
  >,
  status: DurableStatus,
): PluginTriggerData => {
  const capability = available.find(
    (item) =>
      item.pluginId === trigger.pluginId &&
      item.version === trigger.pluginVersion &&
      item.capabilityName === trigger.capabilityName,
  );
  return {
    id: trigger.id,
    pluginId: trigger.pluginId,
    pluginName: capability?.pluginName ?? trigger.pluginId,
    pluginDisplayName: capability?.pluginDisplayName ?? "Unavailable plugin",
    pluginVersion: trigger.pluginVersion,
    source: "webhook",
    sourceLabel: capability?.sourceLabel ?? "Unavailable source",
    capabilityName: trigger.capabilityName,
    event: trigger.event,
    action: trigger.action,
    permission: "trigger-delivery",
    idempotent: trigger.idempotent,
    status: trigger.status,
    hmacConfigured: trigger.hmacSecretReference !== undefined,
    createdAt: trigger.createdAt,
    updatedAt: trigger.updatedAt,
    rotatedAt: trigger.rotatedAt,
    ...status,
  };
};

const listData = Effect.fn("pluginTriggersListData")(function* (
  context: Context<AppEnv>,
) {
  const service = yield* PluginTriggerService;
  const owner = context.get("principal").userId;
  const [triggers, available] = yield* Effect.all([
    service.list(owner),
    service.availableCapabilities(owner),
  ]);
  const statuses = yield* Effect.all(
    triggers.map((trigger) => durableStatus(context, trigger.id)),
    { concurrency: 8 },
  );
  return {
    items: triggers.map((trigger, index) =>
      triggerData(trigger, available, statuses[index] ?? emptyStatus),
    ),
    availableCapabilities: available,
    webhookContract: {
      timestampHeader: "x-dx-timestamp" as const,
      eventIdHeader: "x-dx-event-id" as const,
      idempotencyKeyHeader: "x-dx-idempotency-key" as const,
      signatureHeader: "x-dx-signature" as const,
      replayWindowSeconds: TRIGGER_REPLAY_WINDOW_MS / 1_000,
      maxPayloadBytes: MAX_TRIGGER_PAYLOAD_BYTES,
    },
  };
});

const parseTriggerId = (context: Context<AppEnv>) =>
  decodeRequestInput(
    PluginTriggerParamsSchema,
    { triggerId: context.req.param("triggerId") },
    () => invalid("triggerId", "Use a valid trigger identifier."),
  ).pipe(Effect.map(({ triggerId }) => triggerId));

const failureResponse = (context: Context<AppEnv>, failure: unknown) => {
  const requestId = context.get("requestId");
  const response = (
    schema: Schema.ConstraintEncoder<unknown>,
    status: 401 | 403 | 404 | 409 | 503,
    code: string,
    message: string,
  ) =>
    context.json(
      Schema.encodeUnknownSync(schema)({
        status: "error",
        data: { code, message, requestId },
      }),
      status,
    );
  if (failure instanceof InvalidTriggerRequest) {
    return context.json(
      Schema.encodeUnknownSync(PluginTriggersInvalidRequestResponseSchema)({
        status: "error",
        data: {
          code: "INVALID_TRIGGER_REQUEST",
          message: "Trigger validation failed.",
          requestId,
          fieldErrors: failure.fieldErrors,
        },
      }),
      400,
    );
  }
  if (failure instanceof BrowserSessionRequired)
    return response(
      PluginTriggersBrowserSessionRequiredResponseSchema,
      403,
      "BROWSER_SESSION_REQUIRED",
      "A browser session is required to manage trigger credentials.",
    );
  if (failure instanceof PluginTriggerNotFound)
    return response(
      PluginTriggerNotFoundResponseSchema,
      404,
      "PLUGIN_TRIGGER_NOT_FOUND",
      "Plugin trigger not found.",
    );
  if (failure instanceof PluginTriggerLimitExceeded)
    return response(
      PluginTriggerLimitResponseSchema,
      409,
      "PLUGIN_TRIGGER_LIMIT_EXCEEDED",
      "The personal trigger limit has been reached.",
    );
  if (failure instanceof PluginTriggerCapabilityForbidden)
    return response(
      PluginTriggerForbiddenResponseSchema,
      403,
      "PLUGIN_TRIGGER_FORBIDDEN",
      "The plugin trigger capability is unavailable.",
    );
  if (failure instanceof WorkspacePolicyDenied) {
    return context.json(
      Schema.encodeUnknownSync(PluginTriggersPolicyDeniedResponseSchema)({
        status: "error",
        data: {
          code: "WORKSPACE_POLICY_DENIED",
          message:
            "Workspace policy does not allow this personal trigger resource.",
          requestId,
          reason: failure.reason,
        },
      }),
      403,
    );
  }
  if (failure instanceof PluginTriggerConflict)
    return response(
      PluginTriggerConflictResponseSchema,
      409,
      "PLUGIN_TRIGGER_CONFLICT",
      "The trigger or delivery cannot perform that transition.",
    );
  if (
    failure instanceof PersistenceUnavailable ||
    failure instanceof TriggerDeliveryUnavailable ||
    Schema.isSchemaError(failure)
  ) {
    return response(
      PluginTriggersUnavailableResponseSchema,
      503,
      "PLUGIN_TRIGGERS_UNAVAILABLE",
      "Plugin triggers are temporarily unavailable.",
    );
  }
  throw failure;
};

const run = async <A, E>(
  context: Context<AppEnv>,
  operation: Effect.Effect<A, E>,
  status: 200 | 201 = 200,
) => {
  const result = await Effect.runPromise(Effect.result(operation));
  return Result.isSuccess(result)
    ? context.json(result.success, status)
    : failureResponse(context, result.failure);
};

const operation = <A, E, R>(
  context: Context<AppEnv>,
  use: (db: D1Database) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const db = yield* decodeD1Binding(context.env.DB);
    return yield* use(db).pipe(Effect.provide(layers(db)));
  });

const currentData = Effect.fn("pluginTriggerCurrentData")(function* (
  context: Context<AppEnv>,
  trigger: StoredPluginTrigger,
) {
  const service = yield* PluginTriggerService;
  const available = yield* service.availableCapabilities(trigger.ownerUserId);
  const status = yield* durableStatus(context, trigger.id);
  return triggerData(trigger, available, status);
});

const control = Effect.fn("pluginTriggerControl")(function* (
  context: Context<AppEnv>,
  triggerId: string,
  operationName: "pause" | "resume" | "revoke",
) {
  const { response } = yield* durableFetch(context, triggerId, "/control", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ operation: operationName }),
  });
  if (!response.ok) return yield* new TriggerDeliveryUnavailable();
});

export const personalPluginTriggerRoutes = new Hono<AppEnv>();

personalPluginTriggerRoutes.get("/", (context) =>
  run(
    context,
    operation(context, () =>
      Effect.gen(function* () {
        const data = yield* listData(context);
        return yield* Schema.encodeUnknownEffect(
          ListPluginTriggersResponseSchema,
        )({ status: "success", data });
      }),
    ),
  ),
);

personalPluginTriggerRoutes.post("/", (context) =>
  run(
    context,
    operation(context, (_db) =>
      Effect.gen(function* () {
        const body = yield* decodeJsonBody(
          context.req,
          CreatePluginTriggerRequestSchema,
          () => invalid("request", "Choose an available plugin trigger."),
        );
        const service = yield* PluginTriggerService;
        const available = yield* service.availableCapabilities(
          context.get("principal").userId,
        );
        const created = yield* service.create(
          context.get("principal").userId,
          body,
          {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          },
        );
        const origin = new URL(context.req.url).origin;
        return yield* Schema.encodeUnknownEffect(
          CreatePluginTriggerResponseSchema,
        )({
          status: "success",
          data: {
            trigger: triggerData(created.trigger, available, emptyStatus),
            capability: {
              capabilityUrl: `${origin}/api/triggers/${created.trigger.id}/${created.capability}`,
              token: created.capability,
            },
          },
        });
      }),
    ),
    201,
  ),
);

personalPluginTriggerRoutes.patch("/:triggerId", (context) =>
  run(
    context,
    operation(context, () =>
      Effect.gen(function* () {
        const triggerId = yield* parseTriggerId(context);
        const body = yield* decodeJsonBody(
          context.req,
          UpdatePluginTriggerStateRequestSchema,
          () => invalid("status", "Choose active or paused."),
        );
        const service = yield* PluginTriggerService;
        const trigger = yield* service.changeStatus(
          context.get("principal").userId,
          triggerId,
          body.status,
          {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          },
        );
        yield* control(
          context,
          triggerId,
          body.status === "active" ? "resume" : "pause",
        );
        return yield* Schema.encodeUnknownEffect(
          UpdatePluginTriggerStateResponseSchema,
        )({ status: "success", data: yield* currentData(context, trigger) });
      }),
    ),
  ),
);

personalPluginTriggerRoutes.post("/:triggerId/rotate", (context) =>
  run(
    context,
    operation(context, (_db) =>
      Effect.gen(function* () {
        const triggerId = yield* parseTriggerId(context);
        const service = yield* PluginTriggerService;
        const current = yield* service
          .list(context.get("principal").userId)
          .pipe(
            Effect.flatMap((triggers) => {
              const trigger = triggers.find(({ id }) => id === triggerId);
              return trigger === undefined
                ? Effect.fail(new PluginTriggerNotFound())
                : currentData(context, trigger);
            }),
          );
        const rotated = yield* service.rotate(
          context.get("principal").userId,
          triggerId,
          {
            userId: context.get("principal").userId,
            requestId: context.get("requestId"),
          },
        );
        const origin = new URL(context.req.url).origin;
        return yield* Schema.encodeUnknownEffect(
          RotatePluginTriggerResponseSchema,
        )({
          status: "success",
          data: {
            trigger: {
              ...current,
              updatedAt: rotated.trigger.updatedAt,
              rotatedAt: rotated.trigger.rotatedAt,
            },
            capability: {
              capabilityUrl: `${origin}/api/triggers/${rotated.trigger.id}/${rotated.capability}`,
              token: rotated.capability,
            },
          },
        });
      }),
    ),
  ),
);

personalPluginTriggerRoutes.delete("/:triggerId", (context) =>
  run(
    context,
    operation(context, (_db) =>
      Effect.gen(function* () {
        const triggerId = yield* parseTriggerId(context);
        const service = yield* PluginTriggerService;
        yield* service.revoke(context.get("principal").userId, triggerId, {
          userId: context.get("principal").userId,
          requestId: context.get("requestId"),
        });
        yield* control(context, triggerId, "revoke").pipe(
          Effect.catchTag("TriggerDeliveryUnavailable", () => Effect.void),
        );
        return yield* Schema.encodeUnknownEffect(
          RevokePluginTriggerResponseSchema,
        )({ status: "success", data: { revokedTriggerId: triggerId } });
      }),
    ),
  ),
);

personalPluginTriggerRoutes.post(
  "/:triggerId/deliveries/:deliveryId/retry",
  (context) =>
    run(
      context,
      operation(context, () =>
        Effect.gen(function* () {
          const params = yield* decodeRequestInput(
            PluginTriggerDeliveryParamsSchema,
            {
              triggerId: context.req.param("triggerId"),
              deliveryId: context.req.param("deliveryId"),
            },
            () => invalid("deliveryId", "Use a valid delivery identifier."),
          );
          const repository = yield* PluginTriggerRepository;
          const trigger = yield* repository.find(
            context.get("principal").userId,
            params.triggerId,
          );
          const { response } = yield* durableFetch(
            context,
            params.triggerId,
            "/retry",
            {
              method: "POST",
              headers: { "content-type": "application/json" },
              body: JSON.stringify({ deliveryId: params.deliveryId }),
            },
          );
          if (response.status === 409)
            return yield* new PluginTriggerConflict();
          if (!response.ok) return yield* new TriggerDeliveryUnavailable();
          const now = yield* DateTime.now;
          yield* repository.recordAudit({
            auditId: `taud_${crypto.randomUUID()}`,
            triggerId: params.triggerId,
            ownerUserId: trigger.ownerUserId,
            action: "plugin_trigger.delivery_retried",
            outcome: "success",
            requestId: context.get("requestId"),
            createdAt: now,
          });
          return yield* Schema.encodeUnknownEffect(
            RetryPluginTriggerDeliveryResponseSchema,
          )({
            status: "success",
            data: yield* currentData(context, trigger),
          });
        }),
      ),
    ),
);

const forbiddenIngress = (context: Context<AppEnv>) =>
  context.json(
    {
      status: "error",
      data: {
        code: "TRIGGER_REJECTED",
        message: "The trigger request was rejected.",
        requestId: context.get("requestId"),
      },
    },
    403,
  );

const invalidIngress = (context: Context<AppEnv>, status: 400 | 413 | 415) =>
  context.json(
    {
      status: "error",
      data: {
        code: "INVALID_TRIGGER_REQUEST",
        message: "The trigger request is invalid.",
        requestId: context.get("requestId"),
      },
    },
    status,
  );

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

const verifyHmac = async (
  secret: string,
  message: Uint8Array<ArrayBuffer>,
  value: string,
) => {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const expected = bytesToHex(
    new Uint8Array(await crypto.subtle.sign("HMAC", key, message)),
  );
  return capabilityHashesEqual(`sha256=${expected}`, value);
};

export const pluginTriggerIngressRoutes = new Hono<AppEnv>();

pluginTriggerIngressRoutes.post("/:triggerId/:capability", async (context) => {
  const dbResult = await Effect.runPromise(
    Effect.result(decodeD1Binding(context.env.DB)),
  );
  if (Result.isFailure(dbResult)) return forbiddenIngress(context);
  const path = Schema.decodeUnknownOption(
    Schema.Struct({
      triggerId: PluginTriggerId,
      capability: PluginTriggerCapability,
    }),
  )({
    triggerId: context.req.param("triggerId"),
    capability: context.req.param("capability"),
  });
  if (Option.isNone(path)) return forbiddenIngress(context);
  const triggerResult = await Effect.runPromise(
    Effect.result(
      Effect.gen(function* () {
        const repository = yield* PluginTriggerRepository;
        return yield* repository.findIngress(path.value.triggerId);
      }).pipe(Effect.provide(PluginTriggerRepositoryD1(dbResult.success))),
    ),
  );
  if (Result.isFailure(triggerResult)) return forbiddenIngress(context);
  const trigger = triggerResult.success;
  const hash = await Effect.runPromise(
    hashPluginTriggerCapability(path.value.capability),
  );
  if (
    trigger.status !== "active" ||
    !capabilityHashesEqual(trigger.capabilityHash, hash)
  ) {
    return forbiddenIngress(context);
  }
  const contentType = context.req.header("content-type");
  if (!/^application\/json(?:\s*;.*)?$/i.test(contentType ?? "")) {
    return invalidIngress(context, 415);
  }
  const contentLength = Number(context.req.header("content-length") ?? "0");
  if (
    Number.isFinite(contentLength) &&
    contentLength > MAX_TRIGGER_PAYLOAD_BYTES
  ) {
    return invalidIngress(context, 413);
  }
  const raw = new Uint8Array(await context.req.arrayBuffer());
  if (raw.byteLength > MAX_TRIGGER_PAYLOAD_BYTES) {
    return invalidIngress(context, 413);
  }
  const headers = Schema.decodeUnknownOption(PluginTriggerWebhookHeadersSchema)(
    {
      timestamp: context.req.header("x-dx-timestamp"),
      eventId: context.req.header("x-dx-event-id"),
      idempotencyKey: context.req.header("x-dx-idempotency-key"),
      signature: context.req.header("x-dx-signature"),
    },
  );
  if (Option.isNone(headers)) return invalidIngress(context, 400);
  const timestampNumber = Number(headers.value.timestamp);
  const requestTime =
    headers.value.timestamp.length === 10
      ? timestampNumber * 1_000
      : timestampNumber;
  if (
    !Number.isSafeInteger(requestTime) ||
    Math.abs(Date.now() - requestTime) > TRIGGER_REPLAY_WINDOW_MS
  ) {
    return forbiddenIngress(context);
  }
  let text: string;
  let input: unknown;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(raw);
    input = JSON.parse(text) as unknown;
  } catch {
    return invalidIngress(context, 400);
  }
  const payload = Schema.decodeUnknownOption(
    PluginTriggerWebhookPayloadSchema,
    {
      onExcessProperty: "error",
    },
  )(input);
  if (Option.isNone(payload) || payload.value.event !== trigger.event) {
    return invalidIngress(context, 400);
  }
  const hmacSecretReference = trigger.hmacSecretReference;
  if (hmacSecretReference !== undefined) {
    if (headers.value.signature === undefined) return forbiddenIngress(context);
    const hmacResult = await Effect.runPromise(
      Effect.result(
        Effect.gen(function* () {
          const repository = yield* EnvironmentVariableRepository;
          const variable = yield* repository.find(
            { scope: "personal", id: trigger.ownerUserId },
            hmacSecretReference.id,
          );
          if (variable.kind !== "secret" || !variable.enabled) {
            return yield* new TriggerDeliveryUnavailable();
          }
          const keyring = yield* loadConfigEncryptionKeyring(context.env);
          return yield* decryptEnvironmentVariable(
            keyring,
            {
              id: variable.id,
              target: variable.target,
              name: variable.name,
              kind: variable.kind,
            },
            variable.envelope,
          );
        }).pipe(
          Effect.provide(EnvironmentVariableRepositoryD1(dbResult.success)),
        ),
      ),
    );
    if (Result.isFailure(hmacResult)) return forbiddenIngress(context);
    const prefix = new TextEncoder().encode(
      `${headers.value.timestamp}.${headers.value.eventId}.${headers.value.idempotencyKey}.`,
    );
    const signed = new Uint8Array(prefix.length + raw.length);
    signed.set(prefix);
    signed.set(raw, prefix.length);
    if (
      !(await verifyHmac(hmacResult.success, signed, headers.value.signature))
    ) {
      return forbiddenIngress(context);
    }
  }
  const delivery = await Effect.runPromise(
    Effect.result(
      durableFetch(context, trigger.id, "/enqueue", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          triggerId: trigger.id,
          eventId: headers.value.eventId,
          idempotencyKey: headers.value.idempotencyKey,
          payload: payload.value.data,
        }),
      }),
    ),
  );
  if (Result.isFailure(delivery)) {
    return context.json(
      {
        status: "error",
        data: {
          code: "TRIGGER_UNAVAILABLE",
          message: "The trigger is temporarily unavailable.",
          requestId: context.get("requestId"),
        },
      },
      503,
    );
  }
  if (delivery.success.response.status >= 500) {
    return context.json(
      {
        status: "error",
        data: {
          code: "TRIGGER_UNAVAILABLE",
          message: "The trigger is temporarily unavailable.",
          requestId: context.get("requestId"),
        },
      },
      503,
    );
  }
  if (delivery.success.response.status === 429) {
    return context.json(
      {
        status: "error",
        data: {
          code: "TRIGGER_QUOTA_EXCEEDED",
          message: "The trigger quota has been reached.",
          requestId: context.get("requestId"),
        },
      },
      429,
    );
  }
  if (!delivery.success.response.ok) return forbiddenIngress(context);
  const accepted = delivery.success.body as {
    readonly id?: unknown;
    readonly duplicate?: unknown;
  };
  if (
    typeof accepted.id !== "string" ||
    typeof accepted.duplicate !== "boolean"
  ) {
    return invalidIngress(context, 400);
  }
  return context.json(
    {
      status: "success",
      data: {
        deliveryId: accepted.id,
        duplicate: accepted.duplicate,
      },
    },
    accepted.duplicate ? 200 : 202,
  );
});
