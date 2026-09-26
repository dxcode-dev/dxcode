import {
  EnvironmentVariableConfigReference,
  PluginCapabilityName,
  PluginId,
  PluginTriggerCapability,
  PluginTriggerDelivery,
  PluginTriggerDeliveryId,
  PluginTriggerDeliverySummary,
  PluginTriggerEvent,
  PluginTriggerEventId,
  PluginTriggerId,
  PluginTriggerStatus,
  PluginVersion,
  Timestamp,
  WorkspacePolicyDenialReason,
} from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "./field-error.js";

export const TriggerPluginCapabilityDataSchema = Schema.Struct({
  pluginId: PluginId,
  pluginName: Schema.String,
  pluginDisplayName: Schema.String,
  version: PluginVersion,
  source: Schema.Literal("webhook"),
  sourceLabel: Schema.String,
  capabilityName: PluginCapabilityName,
  description: Schema.String,
  event: PluginTriggerEvent,
  action: PluginCapabilityName,
  permission: Schema.Literal("trigger-delivery"),
  idempotent: Schema.Boolean,
});

export type TriggerPluginCapabilityData =
  typeof TriggerPluginCapabilityDataSchema.Type;

export const PluginTriggerDataSchema = Schema.Struct({
  id: PluginTriggerId,
  pluginId: PluginId,
  pluginName: Schema.String,
  pluginDisplayName: Schema.String,
  pluginVersion: PluginVersion,
  source: Schema.Literal("webhook"),
  sourceLabel: Schema.String,
  capabilityName: PluginCapabilityName,
  event: PluginTriggerEvent,
  action: PluginCapabilityName,
  permission: Schema.Literal("trigger-delivery"),
  idempotent: Schema.Boolean,
  status: PluginTriggerStatus,
  hmacConfigured: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  rotatedAt: Timestamp,
  deliverySummary: PluginTriggerDeliverySummary,
  deliveries: Schema.Array(PluginTriggerDelivery),
});

export type PluginTriggerData = typeof PluginTriggerDataSchema.Type;

export const ListPluginTriggersResponseSchema = successResponse(
  Schema.Struct({
    items: Schema.Array(PluginTriggerDataSchema),
    availableCapabilities: Schema.Array(TriggerPluginCapabilityDataSchema),
    webhookContract: Schema.Struct({
      timestampHeader: Schema.Literal("x-dx-timestamp"),
      eventIdHeader: Schema.Literal("x-dx-event-id"),
      idempotencyKeyHeader: Schema.Literal("x-dx-idempotency-key"),
      signatureHeader: Schema.Literal("x-dx-signature"),
      replayWindowSeconds: Schema.Int,
      maxPayloadBytes: Schema.Int,
    }),
  }),
);

export const CreatePluginTriggerRequestSchema = Schema.Struct({
  pluginId: PluginId,
  pluginVersion: PluginVersion,
  capabilityName: PluginCapabilityName,
  hmacSecretReference: Schema.optional(EnvironmentVariableConfigReference),
});

export const PluginTriggerOneTimeCapabilitySchema = Schema.Struct({
  capabilityUrl: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(2_048),
  ),
  token: PluginTriggerCapability,
});

export const CreatePluginTriggerResponseSchema = successResponse(
  Schema.Struct({
    trigger: PluginTriggerDataSchema,
    capability: PluginTriggerOneTimeCapabilitySchema,
  }),
);

export const PluginTriggerParamsSchema = Schema.Struct({
  triggerId: PluginTriggerId,
});

export const PluginTriggerDeliveryParamsSchema = Schema.Struct({
  triggerId: PluginTriggerId,
  deliveryId: PluginTriggerDeliveryId,
});

export const UpdatePluginTriggerStateRequestSchema = Schema.Struct({
  status: Schema.Literals(["active", "paused"]),
});

export const UpdatePluginTriggerStateResponseSchema = successResponse(
  PluginTriggerDataSchema,
);

export const RotatePluginTriggerResponseSchema = successResponse(
  Schema.Struct({
    trigger: PluginTriggerDataSchema,
    capability: PluginTriggerOneTimeCapabilitySchema,
  }),
);

export const RevokePluginTriggerResponseSchema = successResponse(
  Schema.Struct({ revokedTriggerId: PluginTriggerId }),
);

export const RetryPluginTriggerDeliveryResponseSchema = successResponse(
  PluginTriggerDataSchema,
);

export const PluginTriggerWebhookPayloadSchema = Schema.Struct({
  event: PluginTriggerEvent,
  data: Schema.Unknown,
});

export const PluginTriggerWebhookHeadersSchema = Schema.Struct({
  timestamp: Schema.String.check(Schema.isPattern(/^(?:[0-9]{10}|[0-9]{13})$/)),
  eventId: PluginTriggerEventId,
  idempotencyKey: PluginTriggerEventId,
  signature: Schema.optional(
    Schema.String.check(Schema.isPattern(/^sha256=[a-f0-9]{64}$/)),
  ),
});

export const PluginTriggerWebhookAcceptedResponseSchema = successResponse(
  Schema.Struct({
    deliveryId: PluginTriggerDeliveryId,
    duplicate: Schema.Boolean,
  }),
);

export const PluginTriggersInvalidRequestResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("INVALID_TRIGGER_REQUEST"),
    message: Schema.Literal("Trigger validation failed."),
    requestId: Schema.String,
    fieldErrors: Schema.Array(SettingsFieldErrorSchema),
  }),
});

export const PluginTriggerNotFoundResponseSchema = errorResponse(
  "PLUGIN_TRIGGER_NOT_FOUND",
  "Plugin trigger not found.",
);
export const PluginTriggerForbiddenResponseSchema = errorResponse(
  "PLUGIN_TRIGGER_FORBIDDEN",
  "The plugin trigger capability is unavailable.",
);
export const PluginTriggersPolicyDeniedResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: Schema.Literal("WORKSPACE_POLICY_DENIED"),
    message: Schema.Literal(
      "Workspace policy does not allow this personal trigger resource.",
    ),
    requestId: Schema.String,
    reason: WorkspacePolicyDenialReason,
  }),
});
export const PluginTriggerLimitResponseSchema = errorResponse(
  "PLUGIN_TRIGGER_LIMIT_EXCEEDED",
  "The personal trigger limit has been reached.",
);
export const PluginTriggerConflictResponseSchema = errorResponse(
  "PLUGIN_TRIGGER_CONFLICT",
  "The trigger or delivery cannot perform that transition.",
);
export const PluginTriggersBrowserSessionRequiredResponseSchema = errorResponse(
  "BROWSER_SESSION_REQUIRED",
  "A browser session is required to manage trigger credentials.",
);
export const PluginTriggersUnavailableResponseSchema = errorResponse(
  "PLUGIN_TRIGGERS_UNAVAILABLE",
  "Plugin triggers are temporarily unavailable.",
);

export const PluginTriggersErrorResponseSchema = Schema.Union([
  PluginTriggersInvalidRequestResponseSchema,
  PluginTriggerNotFoundResponseSchema,
  PluginTriggerForbiddenResponseSchema,
  PluginTriggersPolicyDeniedResponseSchema,
  PluginTriggerLimitResponseSchema,
  PluginTriggerConflictResponseSchema,
  PluginTriggersBrowserSessionRequiredResponseSchema,
  PluginTriggersUnavailableResponseSchema,
]);
