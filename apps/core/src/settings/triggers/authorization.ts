import {
  PersistenceUnavailable,
  type PluginTarget,
  PluginTriggerId,
  PluginTriggerNotFound,
  PluginTriggerRepository,
  type StoredPluginTrigger,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { Effect, Layer, Schema } from "effect";
import type { PluginInstallRecord } from "../../plugins/worker-host/host.js";
import { findCodePluginTriggerInstall } from "../../plugins/worker-host/triggers.js";
import { SettingsAudit } from "../audit.js";
import { pluginRunsForOwnerSql } from "../plugins/bundles/overlap.js";
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
  kind: Schema.String,
});

/** A webhook trigger of an installed plugin whose code runs on the worker host. */
export interface AuthorizedCodeTriggerDelivery {
  readonly kind: "code";
  readonly trigger: StoredPluginTrigger;
  readonly target: PluginTarget;
  /** The install's active version, which the delivery runs. */
  readonly install: PluginInstallRecord;
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
  const layer = PluginTriggerRepositoryD1(db);
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
          `SELECT plugin.scope, plugin.target_id, plugin.kind
             FROM trusted_plugin plugin
            WHERE plugin.id = ?1
              AND plugin.kind = 'bundle'
              AND EXISTS (
                SELECT 1 FROM trusted_plugin_version version
                 WHERE version.plugin_id = plugin.id
                   AND version.version = ?2
                   AND version.trusted = 1
              )
              AND ${pluginRunsForOwnerSql("plugin", "?3")}
            LIMIT 1`,
        )
        .bind(trigger.pluginId, trigger.pluginVersion, trigger.ownerUserId)
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
  if (authorized.kind === "bundle") {
    const install = yield* Effect.tryPromise({
      try: () =>
        findCodePluginTriggerInstall(db, trigger.pluginId, trigger.ownerUserId),
      catch: (cause) =>
        PersistenceUnavailable.new(
          { operation: "settings.triggers.authorize-code" },
          cause,
        ),
    });
    if (install === undefined)
      return yield* new TriggerDeliveryForbidden({ reason: "plugin-disabled" });
    // A personal secret (the trigger's HMAC key, or one a personal install
    // reads) needs the workspace to allow personal secret overrides.
    if (
      trigger.hmacSecretReference !== undefined ||
      (install.scope === "personal" &&
        install.code.permissions.secrets.length > 0)
    )
      yield* Effect.gen(function* () {
        const policies = yield* WorkspacePolicyService;
        yield* policies.evaluateForUser(trigger.ownerUserId, {
          kind: "secret.use-personal-override",
        });
      }).pipe(
        Effect.provide(policyDependencies(db)),
        Effect.catchTag("WorkspacePolicyDenied", () =>
          Effect.fail(
            new TriggerDeliveryForbidden({ reason: "plugin-disabled" }),
          ),
        ),
      );
    return {
      kind: "code",
      trigger,
      target: {
        scope: authorized.scope,
        id: authorized.target_id,
      } as PluginTarget,
      install,
    } satisfies AuthorizedCodeTriggerDelivery;
  }
  // Legacy code plugins ran on the per-call E2B host, which is gone: their
  // triggers deliver nothing.
  return yield* new TriggerDeliveryForbidden({ reason: "plugin-disabled" });
});
