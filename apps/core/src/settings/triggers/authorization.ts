import {
  PersistenceUnavailable,
  PluginNotFound,
  PluginRepository,
  type PluginTarget,
  PluginTriggerId,
  PluginTriggerNotFound,
  PluginTriggerRepository,
  type StoredPluginTrigger,
  type StoredPluginVersion,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import { SettingsAudit } from "../audit.js";
import { PluginRepositoryD1 } from "../plugins/repository-d1.js";
import { SettingsService } from "../service.js";
import { WorkspaceRepositoryD1 } from "../workspace/repository-d1.js";
import { WorkspacePolicyRepositoryD1 } from "../workspace-policy/repository-d1.js";
import { WorkspacePolicyService } from "../workspace-policy/service.js";
import { PluginTriggerRepositoryD1 } from "./repository-d1.js";

export class TriggerDeliveryForbidden extends Schema.TaggedError<TriggerDeliveryForbidden>()(
  "TriggerDeliveryForbidden",
  {
    reason: Schema.Literals([
      "not-found",
      "paused",
      "revoked",
      "plugin-disabled",
    ]),
  },
) {}

const PluginAuthorizationRow = Schema.Struct({
  scope: Schema.Literals(["personal", "workspace"]),
  target_id: Schema.String,
});

export interface AuthorizedTriggerDelivery {
  readonly trigger: StoredPluginTrigger;
  readonly target: PluginTarget;
  readonly version: StoredPluginVersion;
}

const policyDependencies = (db: D1Database) => {
  const d1 = D1Client.layer({ db });
  const workspace = WorkspaceRepositoryD1(db).pipe(Layer.provide(d1));
  const settings = SettingsService.layer.pipe(Layer.provide(workspace));
  return WorkspacePolicyService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        workspace,
        settings,
        WorkspacePolicyRepositoryD1(db),
        SettingsAudit.layer,
      ),
    ),
  );
};

export const loadAuthorizedTriggerDelivery = Effect.fn(
  "loadAuthorizedTriggerDelivery",
)(function* (db: D1Database, rawTriggerId: string) {
  const triggerId = yield* Schema.decodeUnknownEffect(PluginTriggerId)(
    rawTriggerId,
  ).pipe(
    Effect.mapError(
      () => new TriggerDeliveryForbidden({ reason: "not-found" }),
    ),
  );
  const layer = Layer.merge(
    PluginTriggerRepositoryD1(db),
    PluginRepositoryD1(db),
  );
  const trigger = yield* Effect.gen(function* () {
    const repository = yield* PluginTriggerRepository;
    return yield* repository.findIngress(triggerId);
  }).pipe(
    Effect.provide(layer),
    Effect.mapError((failure) =>
      failure instanceof PluginTriggerNotFound
        ? new TriggerDeliveryForbidden({ reason: "not-found" })
        : failure,
    ),
  );
  if (trigger.status !== "active") {
    return yield* new TriggerDeliveryForbidden({ reason: trigger.status });
  }
  const row = yield* Effect.tryPromise({
    try: () =>
      db
        .prepare(
          `SELECT plugin.scope, plugin.target_id
             FROM trusted_plugin plugin
            WHERE plugin.id = ?
              AND plugin.enabled = 1
              AND plugin.removed_at IS NULL
              AND EXISTS (
                SELECT 1 FROM trusted_plugin_version version
                 WHERE version.plugin_id = plugin.id
                   AND version.version = ?
                   AND version.trusted = 1
              )
              AND (
                (
                  plugin.scope = 'workspace'
                  AND EXISTS (
                    SELECT 1 FROM member
                     WHERE member.userId = ?
                       AND member.organizationId = plugin.target_id
                  )
                )
                OR (
                  plugin.scope = 'personal'
                  AND plugin.target_id = ?
                  AND NOT EXISTS (
                    SELECT 1 FROM member
                    JOIN trusted_plugin_workspace_policy policy
                      ON policy.workspace_id = member.organizationId
                   WHERE member.userId = ?
                     AND policy.allow_personal_plugins = 0
                  )
                  AND NOT EXISTS (
                    SELECT 1 FROM member
                    JOIN trusted_plugin workspace_plugin
                      ON workspace_plugin.scope = 'workspace'
                     AND workspace_plugin.target_id = member.organizationId
                     AND workspace_plugin.name = plugin.name
                     AND workspace_plugin.enabled = 1
                     AND workspace_plugin.removed_at IS NULL
                   WHERE member.userId = ?
                  )
                )
              )
            LIMIT 1`,
        )
        .bind(
          trigger.pluginId,
          trigger.pluginVersion,
          trigger.ownerUserId,
          trigger.ownerUserId,
          trigger.ownerUserId,
          trigger.ownerUserId,
        )
        .first(),
    catch: (cause) =>
      PersistenceUnavailable.new(
        { operation: "settings.triggers.authorize" },
        cause,
      ),
  });
  if (row === null) {
    return yield* new TriggerDeliveryForbidden({ reason: "plugin-disabled" });
  }
  const authorized = yield* Schema.decodeUnknownEffect(PluginAuthorizationRow)(
    row,
  );
  const version = yield* Effect.gen(function* () {
    const repository = yield* PluginRepository;
    return yield* repository.findVersion(
      trigger.pluginId,
      trigger.pluginVersion,
    );
  }).pipe(
    Effect.provide(layer),
    Effect.mapError((failure) =>
      failure instanceof PluginNotFound
        ? new TriggerDeliveryForbidden({ reason: "plugin-disabled" })
        : failure,
    ),
  );
  const declaration = version.manifest.triggers.find(
    ({ name }) => name === trigger.capabilityName,
  );
  if (
    declaration === undefined ||
    !version.grants.triggers.includes(trigger.capabilityName) ||
    declaration.source !== trigger.source ||
    declaration.event !== trigger.event ||
    declaration.action !== trigger.action ||
    declaration.idempotent !== trigger.idempotent
  ) {
    return yield* new TriggerDeliveryForbidden({ reason: "plugin-disabled" });
  }
  const target = {
    scope: authorized.scope,
    id: authorized.target_id,
  } as PluginTarget;
  const personalSecretRequired =
    trigger.hmacSecretReference !== undefined ||
    (target.scope === "personal" && version.grants.secretReferences.length > 0);
  const personalMcpRequired =
    target.scope === "personal" && version.grants.mcpServerIds.length > 0;
  if (personalSecretRequired || personalMcpRequired) {
    yield* Effect.gen(function* () {
      const policies = yield* WorkspacePolicyService;
      if (personalSecretRequired) {
        yield* policies.evaluateForUser(trigger.ownerUserId, {
          kind: "secret.use-personal-override",
        });
      }
      if (personalMcpRequired) {
        yield* policies.evaluateForUser(trigger.ownerUserId, {
          kind: "mcp.use-personal-override",
        });
      }
    }).pipe(
      Effect.provide(policyDependencies(db)),
      Effect.catchTag("WorkspacePolicyDenied", () =>
        Effect.fail(
          new TriggerDeliveryForbidden({ reason: "plugin-disabled" }),
        ),
      ),
    );
  }
  return {
    trigger,
    target,
    version,
  } satisfies AuthorizedTriggerDelivery;
});
