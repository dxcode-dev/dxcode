import type { TriggerPluginCapabilityData } from "@dx/api";
import {
  EnvironmentVariableRepository,
  MAX_PLUGIN_TRIGGERS_PER_USER,
  PluginTriggerCapability,
  PluginTriggerCapabilityForbidden,
  PluginTriggerCapabilityHash,
  PluginTriggerConflict,
  type PluginTriggerId,
  PluginTriggerLimitExceeded,
  PluginTriggerRepository,
  type PluginTriggerStatus,
  StoredPluginTrigger,
  type UserId,
} from "@dx/domain";
import { Context, DateTime, Effect, Layer, Schema } from "effect";
import { encodeBase64Url } from "../../encoding/base64.js";
import {
  CODE_TRIGGER_EVENT,
  CodePluginTriggerCapabilities,
} from "../../plugins/worker-host/triggers.js";
import { SettingsAudit } from "../audit.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";

interface TriggerAuditContext {
  readonly requestId: string;
  readonly userId: UserId;
}

interface CreateTriggerInput {
  readonly pluginId: typeof import("@dx/domain").PluginId.Type;
  readonly pluginVersion: typeof import("@dx/domain").PluginVersion.Type;
  readonly capabilityName: typeof import("@dx/domain").PluginCapabilityName.Type;
  readonly hmacSecretReference?:
    | typeof import("@dx/domain").EnvironmentVariableConfigReference.Type
    | undefined;
}

interface PluginTriggerServiceShape {
  readonly list: (
    ownerUserId: UserId,
  ) => ReturnType<typeof PluginTriggerRepository.Service.list>;
  readonly availableCapabilities: (
    ownerUserId: UserId,
  ) => Effect.Effect<ReadonlyArray<TriggerPluginCapabilityData>, unknown>;
  readonly create: (
    ownerUserId: UserId,
    input: CreateTriggerInput,
    audit: TriggerAuditContext,
  ) => Effect.Effect<
    {
      readonly trigger: typeof StoredPluginTrigger.Type;
      readonly capability: typeof PluginTriggerCapability.Type;
    },
    unknown
  >;
  readonly changeStatus: (
    ownerUserId: UserId,
    id: typeof PluginTriggerId.Type,
    status: Extract<PluginTriggerStatus, "active" | "paused">,
    audit: TriggerAuditContext,
  ) => Effect.Effect<typeof StoredPluginTrigger.Type, unknown>;
  readonly rotate: (
    ownerUserId: UserId,
    id: typeof PluginTriggerId.Type,
    audit: TriggerAuditContext,
  ) => Effect.Effect<
    {
      readonly trigger: typeof StoredPluginTrigger.Type;
      readonly capability: typeof PluginTriggerCapability.Type;
    },
    unknown
  >;
  readonly revoke: (
    ownerUserId: UserId,
    id: typeof PluginTriggerId.Type,
    audit: TriggerAuditContext,
  ) => Effect.Effect<void, unknown>;
}

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const generatePluginTriggerCapability =
  (): typeof PluginTriggerCapability.Type =>
    Schema.decodeUnknownSync(PluginTriggerCapability)(
      `dxt_${encodeBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
    );

export const hashPluginTriggerCapability = Effect.fn(
  "hashPluginTriggerCapability",
)(function* (capability: string) {
  const digest = yield* Effect.promise(() =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(capability)),
  );
  return yield* Schema.decodeUnknownEffect(PluginTriggerCapabilityHash)(
    bytesToHex(new Uint8Array(digest)),
  );
});

export const capabilityHashesEqual = (left: string, right: string): boolean => {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index += 1) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
};

/**
 * Whether a listed capability is the one a trigger uses. A plugin with code
 * delivers to its install's active version, so its triggers match across
 * updates; a legacy plugin's trigger stays on the version it was made for.
 */
export const capabilityMatchesTrigger = (
  candidate: TriggerPluginCapabilityData,
  trigger: {
    readonly pluginId: string;
    readonly pluginVersion: string;
    readonly capabilityName: string;
    readonly event: string;
  },
) =>
  candidate.pluginId === trigger.pluginId &&
  candidate.capabilityName === trigger.capabilityName &&
  (candidate.version === trigger.pluginVersion ||
    (trigger.event === CODE_TRIGGER_EVENT &&
      candidate.event === CODE_TRIGGER_EVENT));

export class PluginTriggerService extends Context.Service<
  PluginTriggerService,
  PluginTriggerServiceShape
>()("@dx/core/settings/triggers/PluginTriggerService") {
  static readonly layer = Layer.effect(
    PluginTriggerService,
    Effect.gen(function* () {
      const triggers = yield* PluginTriggerRepository;
      const environment = yield* EnvironmentVariableRepository;
      const settingsAudit = yield* SettingsAudit;
      const workspacePolicies = yield* WorkspacePolicyService;
      const codeCapabilities = yield* CodePluginTriggerCapabilities;

      const availableCapabilities = Effect.fn(
        "PluginTriggerService.availableCapabilities",
      )(function* (ownerUserId: UserId) {
        const capabilities: Array<TriggerPluginCapabilityData> = [];
        // Plugins whose code runs on the worker host handle trigger.received.
        capabilities.push(...(yield* codeCapabilities.list(ownerUserId)));
        return capabilities;
      });

      const recordAudit = Effect.fn("PluginTriggerService.recordAudit")(
        function* (
          action: string,
          triggerId: typeof PluginTriggerId.Type,
          context: TriggerAuditContext,
        ) {
          const createdAt = yield* DateTime.now;
          yield* triggers.recordAudit({
            auditId: `taud_${crypto.randomUUID()}`,
            triggerId,
            ownerUserId: context.userId,
            action,
            outcome: "success",
            requestId: context.requestId,
            createdAt,
          });
          yield* settingsAudit.record({
            action,
            scope: "personal",
            outcome: "success",
            requestId: context.requestId,
            userId: context.userId,
            pluginTriggerId: triggerId,
          });
        },
      );

      return PluginTriggerService.of({
        list: triggers.list,
        availableCapabilities,
        create: Effect.fn("PluginTriggerService.create")(
          function* (ownerUserId, input, audit) {
            const existing = yield* triggers.list(ownerUserId);
            if (
              existing.filter(({ status }) => status !== "revoked").length >=
              MAX_PLUGIN_TRIGGERS_PER_USER
            ) {
              return yield* new PluginTriggerLimitExceeded();
            }
            const capabilities = yield* availableCapabilities(ownerUserId);
            const capability = capabilities.find(
              (candidate) =>
                candidate.pluginId === input.pluginId &&
                candidate.version === input.pluginVersion &&
                candidate.capabilityName === input.capabilityName,
            );
            if (capability === undefined) {
              return yield* new PluginTriggerCapabilityForbidden();
            }
            if (input.hmacSecretReference !== undefined) {
              yield* workspacePolicies.evaluateForUser(ownerUserId, {
                kind: "secret.use-personal-override",
              });
              const variable = yield* environment
                .find(
                  { scope: "personal", id: ownerUserId },
                  input.hmacSecretReference.id,
                )
                .pipe(
                  Effect.catch(() =>
                    Effect.fail(new PluginTriggerCapabilityForbidden()),
                  ),
                );
              if (variable.kind !== "secret" || !variable.enabled) {
                return yield* new PluginTriggerCapabilityForbidden();
              }
            }
            const plaintext = generatePluginTriggerCapability();
            const capabilityHash =
              yield* hashPluginTriggerCapability(plaintext);
            const now = yield* DateTime.now;
            const trigger = yield* Schema.decodeUnknownEffect(
              Schema.toType(StoredPluginTrigger),
            )({
              id: `trg_${crypto.randomUUID()}`,
              ownerUserId,
              pluginId: capability.pluginId,
              pluginVersion: capability.version,
              capabilityName: capability.capabilityName,
              source: capability.source,
              event: capability.event,
              action: capability.action,
              idempotent: capability.idempotent,
              status: "active",
              capabilityHash,
              ...(input.hmacSecretReference === undefined
                ? {}
                : { hmacSecretReference: input.hmacSecretReference }),
              createdAt: now,
              updatedAt: now,
              rotatedAt: now,
            });
            yield* triggers
              .insert(trigger)
              .pipe(
                Effect.catchTag("PluginTriggerConflict", () =>
                  Effect.fail(new PluginTriggerConflict()),
                ),
              );
            yield* recordAudit("plugin_trigger.create", trigger.id, audit);
            return { trigger, capability: plaintext };
          },
        ),
        changeStatus: Effect.fn("PluginTriggerService.changeStatus")(
          function* (ownerUserId, id, status, audit) {
            const current = yield* triggers.find(ownerUserId, id);
            if (current.status === "revoked") {
              return yield* new PluginTriggerConflict();
            }
            if (current.status === status) return current;
            if (status === "active") {
              if (current.hmacSecretReference !== undefined) {
                yield* workspacePolicies.evaluateForUser(ownerUserId, {
                  kind: "secret.use-personal-override",
                });
              }
              const capabilities = yield* availableCapabilities(ownerUserId);
              if (
                !capabilities.some((candidate) =>
                  capabilityMatchesTrigger(candidate, current),
                )
              ) {
                return yield* new PluginTriggerCapabilityForbidden();
              }
            }
            const now = yield* DateTime.now;
            yield* triggers.updateStatus(ownerUserId, id, status, now);
            yield* recordAudit(`plugin_trigger.${status}`, id, audit);
            return yield* triggers.find(ownerUserId, id);
          },
        ),
        rotate: Effect.fn("PluginTriggerService.rotate")(
          function* (ownerUserId, id, audit) {
            const current = yield* triggers.find(ownerUserId, id);
            if (current.status === "revoked")
              return yield* new PluginTriggerConflict();
            const capability = generatePluginTriggerCapability();
            const hash = yield* hashPluginTriggerCapability(capability);
            const now = yield* DateTime.now;
            yield* triggers.rotateCapability(ownerUserId, id, hash, now);
            yield* recordAudit("plugin_trigger.rotate", id, audit);
            return {
              trigger: yield* triggers.find(ownerUserId, id),
              capability,
            };
          },
        ),
        revoke: Effect.fn("PluginTriggerService.revoke")(
          function* (ownerUserId, id, audit) {
            const current = yield* triggers.find(ownerUserId, id);
            if (current.status === "revoked")
              return yield* new PluginTriggerConflict();
            const now = yield* DateTime.now;
            yield* triggers.updateStatus(ownerUserId, id, "revoked", now);
            yield* recordAudit("plugin_trigger.revoke", id, audit);
          },
        ),
      });
    }),
  );
}
