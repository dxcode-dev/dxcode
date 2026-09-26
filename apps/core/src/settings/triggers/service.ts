import type { TriggerPluginCapabilityData } from "@dx/api";
import {
  EnvironmentVariableRepository,
  MAX_PLUGIN_TRIGGERS_PER_USER,
  PluginRepository,
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

const bytesToBase64Url = (bytes: Uint8Array): string => {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replace(/=+$/, "");
};

const bytesToHex = (bytes: Uint8Array): string =>
  Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");

export const generatePluginTriggerCapability =
  (): typeof PluginTriggerCapability.Type =>
    Schema.decodeUnknownSync(PluginTriggerCapability)(
      `dxt_${bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)))}`,
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

export class PluginTriggerService extends Context.Service<
  PluginTriggerService,
  PluginTriggerServiceShape
>()("@dx/core/settings/triggers/PluginTriggerService") {
  static readonly layer = Layer.effect(
    PluginTriggerService,
    Effect.gen(function* () {
      const triggers = yield* PluginTriggerRepository;
      const plugins = yield* PluginRepository;
      const environment = yield* EnvironmentVariableRepository;
      const settingsAudit = yield* SettingsAudit;
      const workspacePolicies = yield* WorkspacePolicyService;

      const availableCapabilities = Effect.fn(
        "PluginTriggerService.availableCapabilities",
      )(function* (ownerUserId: UserId) {
        const effective = yield* plugins.listEffectiveForUser(ownerUserId);
        const capabilities: Array<TriggerPluginCapabilityData> = [];
        for (const { plugin, active } of effective) {
          if (!active.trusted) continue;
          if (plugin.target.scope === "personal") {
            if (active.grants.secretReferences.length > 0) {
              const allowed = yield* workspacePolicies
                .evaluateForUser(ownerUserId, {
                  kind: "secret.use-personal-override",
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchTag("WorkspacePolicyDenied", (denial) =>
                    denial.reason === "personal-secret-overrides-disabled"
                      ? Effect.succeed(false)
                      : Effect.fail(denial),
                  ),
                );
              if (!allowed) continue;
            }
            if (active.grants.mcpServerIds.length > 0) {
              const allowed = yield* workspacePolicies
                .evaluateForUser(ownerUserId, {
                  kind: "mcp.use-personal-override",
                })
                .pipe(
                  Effect.as(true),
                  Effect.catchTag("WorkspacePolicyDenied", (denial) =>
                    denial.reason === "personal-mcp-overrides-disabled"
                      ? Effect.succeed(false)
                      : Effect.fail(denial),
                  ),
                );
              if (!allowed) continue;
            }
          }
          capabilities.push(
            ...active.manifest.triggers
              .filter(({ name }) => active.grants.triggers.includes(name))
              .map(
                (declaration): TriggerPluginCapabilityData => ({
                  pluginId: plugin.id,
                  pluginName: plugin.name,
                  pluginDisplayName: active.manifest.displayName,
                  version: active.version,
                  source: declaration.source,
                  sourceLabel: active.source.label,
                  capabilityName: declaration.name,
                  description: declaration.description,
                  event: declaration.event,
                  action: declaration.action,
                  permission: "trigger-delivery",
                  idempotent: declaration.idempotent,
                }),
              ),
          );
        }
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
                !capabilities.some(
                  (candidate) =>
                    candidate.pluginId === current.pluginId &&
                    candidate.version === current.pluginVersion &&
                    candidate.capabilityName === current.capabilityName,
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
