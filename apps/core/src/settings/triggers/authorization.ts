import {
  PersistenceUnavailable,
  type PluginTarget,
  PluginTriggerId,
  PluginTriggerNotFound,
  PluginTriggerRepository,
  type StoredPluginTrigger,
} from "@dx/domain";
import { D1Client } from "@effect/sql-d1";
import { getLogger } from "@logtape/logtape";
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

const logger = getLogger(["dx", "settings", "triggers"]);

/**
 * A trigger whose plugin no longer runs for its owner: disabled, removed,
 * paused by an overlap, or a workspace's plugin after the owner left the
 * workspace. Logged and audited, then refused.
 */
const refuse = (db: D1Database, trigger: StoredPluginTrigger) =>
  Effect.gen(function* () {
    const auditId = `taud_${crypto.randomUUID()}`;
    logger.warn("A trigger's plugin no longer runs for its owner; refused.", {
      event: "plugin_trigger_refused",
      triggerId: trigger.id,
      ownerUserId: trigger.ownerUserId,
      pluginId: trigger.pluginId,
      reason: "plugin-unreachable",
      auditId,
    });
    // One row a minute per trigger at most: the URL's holder may keep
    // posting, and audit rows are permanent. One statement, no extra read.
    const now = new Date();
    yield* Effect.tryPromise(() =>
      db
        .prepare(
          `INSERT INTO plugin_trigger_audit (
             audit_id, trigger_id, owner_user_id, action, outcome, request_id,
             created_at
           )
           SELECT ?1, ?2, ?3, 'plugin_trigger.delivery_refused', 'rejected', ?1, ?4
            WHERE NOT EXISTS (
              SELECT 1 FROM plugin_trigger_audit recent
               WHERE recent.owner_user_id = ?3
                 AND recent.trigger_id = ?2
                 AND recent.action = 'plugin_trigger.delivery_refused'
                 AND recent.created_at > ?5)`,
        )
        .bind(
          auditId,
          trigger.id,
          trigger.ownerUserId,
          now.toISOString(),
          new Date(now.getTime() - 60_000).toISOString(),
        )
        .run(),
    ).pipe(Effect.ignore);
    return yield* new TriggerDeliveryForbidden({ reason: "plugin-disabled" });
  });

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
    return yield* refuse(db, trigger);
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
    if (install === undefined) return yield* refuse(db, trigger);
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
