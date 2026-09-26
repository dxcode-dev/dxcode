import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { EnvironmentVariableConfigReference } from "./environment-variable.js";
import {
  PluginCapabilityName,
  PluginId,
  PluginTriggerEvent,
  PluginVersion,
} from "./plugin.js";

export const MAX_PLUGIN_TRIGGERS_PER_USER = 20;
export const MAX_TRIGGER_PAYLOAD_BYTES = 65_536;
export const MAX_TRIGGER_PENDING_DELIVERIES = 100;
export const MAX_TRIGGER_EVENTS_PER_MINUTE = 60;
export const MAX_TRIGGER_DELIVERY_ATTEMPTS = 6;
export const TRIGGER_REPLAY_WINDOW_MS = 5 * 60 * 1_000;
export const TRIGGER_DELIVERY_LEASE_MS = 30 * 1_000;
export const TRIGGER_HISTORY_LIMIT = 50;

export const PluginTriggerId = Schema.String.check(
  Schema.isPattern(
    /^trg_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/PluginTriggerId"));

export type PluginTriggerId = typeof PluginTriggerId.Type;

export const PluginTriggerDeliveryId = Schema.String.check(
  Schema.isPattern(
    /^tdl_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/PluginTriggerDeliveryId"));

export type PluginTriggerDeliveryId = typeof PluginTriggerDeliveryId.Type;

export const PluginTriggerEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
  Schema.isPattern(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/),
).pipe(Schema.brand("@dx/PluginTriggerEventId"));

export type PluginTriggerEventId = typeof PluginTriggerEventId.Type;

export const PluginTriggerCapability = Schema.String.check(
  Schema.isPattern(/^dxt_[A-Za-z0-9_-]{43}$/),
).pipe(Schema.brand("@dx/PluginTriggerCapability"));

export type PluginTriggerCapability = typeof PluginTriggerCapability.Type;

export const PluginTriggerCapabilityHash = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/PluginTriggerCapabilityHash"));

export type PluginTriggerCapabilityHash =
  typeof PluginTriggerCapabilityHash.Type;

export const PluginTriggerStatus = Schema.Literals([
  "active",
  "paused",
  "revoked",
]);

export type PluginTriggerStatus = typeof PluginTriggerStatus.Type;

export const PluginTriggerDeliveryStatus = Schema.Literals([
  "pending",
  "in-flight",
  "succeeded",
  "dead-letter",
  "cancelled",
]);

export type PluginTriggerDeliveryStatus =
  typeof PluginTriggerDeliveryStatus.Type;

export const PluginTriggerFailureCode = Schema.Literals([
  "execution-unavailable",
  "execution-limited",
  "plugin-disabled",
  "lease-expired",
]);

export type PluginTriggerFailureCode = typeof PluginTriggerFailureCode.Type;

export const StoredPluginTrigger = Schema.Struct({
  id: PluginTriggerId,
  ownerUserId: UserId,
  pluginId: PluginId,
  pluginVersion: PluginVersion,
  capabilityName: PluginCapabilityName,
  source: Schema.Literal("webhook"),
  event: PluginTriggerEvent,
  action: PluginCapabilityName,
  idempotent: Schema.Boolean,
  status: PluginTriggerStatus,
  capabilityHash: PluginTriggerCapabilityHash,
  hmacSecretReference: Schema.optional(EnvironmentVariableConfigReference),
  createdAt: Timestamp,
  updatedAt: Timestamp,
  rotatedAt: Timestamp,
  revokedAt: Schema.optional(Timestamp),
});

export type StoredPluginTrigger = typeof StoredPluginTrigger.Type;

export const PluginTriggerDelivery = Schema.Struct({
  id: PluginTriggerDeliveryId,
  eventId: PluginTriggerEventId,
  status: PluginTriggerDeliveryStatus,
  attempts: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  idempotent: Schema.Boolean,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  nextAttemptAt: Schema.optional(Timestamp),
  failureCode: Schema.optional(PluginTriggerFailureCode),
});

export type PluginTriggerDelivery = typeof PluginTriggerDelivery.Type;

export const PluginTriggerDeliverySummary = Schema.Struct({
  pending: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  inFlight: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  succeeded: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  deadLetter: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  cancelled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

export type PluginTriggerDeliverySummary =
  typeof PluginTriggerDeliverySummary.Type;
