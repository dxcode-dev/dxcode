import { makeExecutionWorkspaces } from "../../execution/execution-workspaces.js";
import type { Bindings } from "../../http/types.js";
import { pluginRunsForOwnerSql } from "../../settings/plugins/bundles/overlap.js";
import { ensureService, stopService } from "./host.js";
import { loadRunningInstall, loadServiceInstall } from "./installs.js";
import { pluginServiceLogger } from "./log.js";
import { type PluginOrbId, pluginOrbExecutionKey } from "./orb-owner.js";
import { syncServiceSchedules } from "./schedules.js";

/**
 * The minute sweep that keeps plugin services and plugin Orbs in step with
 * installs (wiki/plugin-platform-direction.md "Plugin services"). Every job
 * that starts, keeps, stops, or removes a plugin Orb is here, so no plugin
 * Orb is left running with nothing pointing at it:
 *
 * 1. An install turned on, installed, or updated whose service must run
 *    without a call (it has schedules, listeners, or keeps running) is
 *    started, and its schedules are written.
 * 2. A service whose install was turned off, paused by its workspace's copy,
 *    or removed is stopped and its schedules go.
 * 3. An Orb none of whose services runs is stopped (`services-off`): its
 *    Orb is released (paused) and costs nothing; state lives in dx.
 * 4. An Orb whose payer left its workspace is stopped (`payer-left`).
 * 5. An Orb whose own install, payer account, or workspace is gone, that
 *    stayed stopped for a week, that no service used for two weeks
 *    (retention), or that a deployment admin's account removal marked
 *    `removing`, is destroyed and its rows deleted. State lives in dx, so
 *    the next call starts a fresh Orb and loses nothing.
 * 6. A `keepRunning` service is ensured every minute, which keeps its Orb
 *    awake and starts it again after dxd updated itself. One that still
 *    said "starting" a minute ago (a cold start nothing has called yet) is
 *    asked again under 1 until dxd says it runs.
 * 7. A plugin with schedules but no service (its function code runs them)
 *    gets its schedule rows written when they differ from its manifest.
 *    It never starts an Orb.
 *
 * Idle sleep, per-minute billing, and the stop when credit runs out cover
 * plugin Orbs as they cover Threads' Orbs: they key on the Orb's ID, which
 * plugin Orbs share with the execution stack (orb-owner.ts).
 */

const RECONCILE_PER_TICK = 10;
const STOPPED_DESTROY_AFTER_MS = 7 * 24 * 60 * 60_000;
const UNUSED_DESTROY_AFTER_MS = 14 * 24 * 60 * 60_000;

const runsSql = pluginRunsForOwnerSql(
  "plugin",
  "CASE WHEN plugin.scope = 'personal' THEN plugin.target_id ELSE version.trusted_by_user_id END",
);

export const sweepPluginServices = async (
  bindings: Bindings,
  now: Date,
  waitUntil: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  if (db === undefined) return;
  const nowIso = now.toISOString();
  const [
    starting,
    stopping,
    idleOrbs,
    leftOrbs,
    goneOrbs,
    keepAwake,
    functionSchedules,
  ] = await db.batch([
    // 1. Installs whose service should run on its own but has not
    // started at this version.
    db
      .prepare(
        `SELECT plugin.id FROM trusted_plugin AS plugin
             JOIN trusted_plugin_version AS version
               ON version.plugin_id = plugin.id
              AND version.version = plugin.active_version
            WHERE plugin.kind = 'bundle'
              AND json_type(version.manifest_json, '$.code.service') = 'object'
              AND (json_type(version.manifest_json, '$.code.schedules') = 'array'
                OR json_type(version.manifest_json, '$.code.listeners') = 'array'
                OR json_extract(version.manifest_json, '$.code.service.keepRunning') = 1)
              AND ${runsSql}
              AND NOT EXISTS (
                SELECT 1 FROM plugin_service AS service
                 WHERE service.plugin_id = plugin.id
                   AND service.version = plugin.active_version
                   AND (service.status = 'running'
                     -- A keepRunning service that said "starting" a minute
                     -- ago is asked again: nothing calls it, so only this
                     -- ensure sees it run (and its Orb is kept awake anyway).
                     OR (service.status = 'starting'
                       AND (json_extract(version.manifest_json, '$.code.service.keepRunning') IS NOT 1
                         OR service.updated_at > ?3))
                     -- A refused or failed start is tried again every five
                     -- minutes, so choosing an Orb starts it soon after.
                     OR (service.status IN ('refused', 'failed')
                       AND service.updated_at > ?2)))
            LIMIT ?1`,
      )
      .bind(
        RECONCILE_PER_TICK,
        new Date(now.getTime() - 5 * 60_000).toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
      ),
    // 2. Services whose install no longer runs.
    db.prepare(
      `SELECT service.plugin_id, service.orb_id FROM plugin_service AS service
            WHERE service.status <> 'off'
              AND NOT EXISTS (
                SELECT 1 FROM trusted_plugin AS plugin
                  JOIN trusted_plugin_version AS version
                    ON version.plugin_id = plugin.id
                   AND version.version = plugin.active_version
                 WHERE plugin.id = service.plugin_id AND ${runsSql})
            LIMIT 50`,
    ),
    // 3. Active Orbs with no running service, older than ten minutes.
    db
      .prepare(
        `SELECT orb.id FROM plugin_orb AS orb
            WHERE orb.state = 'active' AND orb.created_at < ?
              AND NOT EXISTS (
                SELECT 1 FROM plugin_service AS service
                 WHERE service.orb_id = orb.id AND service.status <> 'off')`,
      )
      .bind(new Date(now.getTime() - 10 * 60_000).toISOString()),
    // 4. Active workspace Orbs whose payer left the workspace.
    db.prepare(
      `SELECT orb.id FROM plugin_orb AS orb
          WHERE orb.state = 'active' AND orb.scope = 'workspace'
            AND NOT EXISTS (
              SELECT 1 FROM member
                JOIN organization ON organization.id = member.organizationId
               WHERE member.organizationId = orb.target_id
                 AND member.userId = orb.payer_user_id
                 AND organization.lifecycleState = 'active')`,
    ),
    // 5. Orbs to destroy: their own install, payer, or workspace is gone,
    // or they stayed stopped for a week.
    db
      .prepare(
        `SELECT orb.id FROM plugin_orb AS orb
            WHERE orb.state = 'removing'
               OR (orb.plugin_id IS NOT NULL AND NOT EXISTS (
                    SELECT 1 FROM trusted_plugin
                     WHERE id = orb.plugin_id AND removed_at IS NULL))
               OR NOT EXISTS (SELECT 1 FROM "user" WHERE id = orb.payer_user_id)
               OR (orb.scope = 'workspace' AND NOT EXISTS (
                    SELECT 1 FROM organization
                     WHERE id = orb.target_id AND lifecycleState = 'active'))
               OR (orb.state = 'stopped' AND orb.updated_at < ?1)
               -- Retention: no service on it was used for two weeks.
               OR (orb.created_at < ?2 AND NOT EXISTS (
                    SELECT 1 FROM plugin_service AS service
                     WHERE service.orb_id = orb.id AND service.updated_at >= ?2))
            LIMIT 10`,
      )
      .bind(
        new Date(now.getTime() - STOPPED_DESTROY_AFTER_MS).toISOString(),
        new Date(now.getTime() - UNUSED_DESTROY_AFTER_MS).toISOString(),
      ),
    // 6. Orbs a running service asks to keep awake.
    db.prepare(
      `SELECT service.plugin_id AS id FROM plugin_service AS service
           JOIN plugin_orb AS orb ON orb.id = service.orb_id
          WHERE orb.state = 'active' AND orb.keep_running = 1
            AND service.status = 'running'`,
    ),
    // 7. Function-code schedules whose rows differ from the manifest.
    db
      .prepare(
        `SELECT plugin.id FROM trusted_plugin AS plugin
             JOIN trusted_plugin_version AS version
               ON version.plugin_id = plugin.id
              AND version.version = plugin.active_version
            WHERE plugin.kind = 'bundle'
              AND json_type(version.manifest_json, '$.code.service') IS NULL
              AND json_type(version.manifest_json, '$.code.schedules') = 'array'
              AND ${runsSql}
              AND EXISTS (
                SELECT 1 FROM json_each(version.manifest_json, '$.code.schedules') AS declared
                 WHERE NOT EXISTS (
                   SELECT 1 FROM plugin_service_schedule AS row
                    WHERE row.plugin_id = plugin.id
                      AND row.name = json_extract(declared.value, '$.name')
                      AND row.spec = CASE
                        WHEN json_extract(declared.value, '$.every') IS NOT NULL
                          THEN 'every:' || json_extract(declared.value, '$.every')
                        ELSE 'cron:' || json_extract(declared.value, '$.cron') END))
            LIMIT ?`,
      )
      .bind(RECONCILE_PER_TICK),
  ]);
  const ids = (result: D1Result | undefined) =>
    (result?.results ?? []) as ReadonlyArray<Record<string, string | null>>;

  for (const { id } of ids(starting)) {
    if (id === null || id === undefined) continue;
    waitUntil(
      (async () => {
        const install = await loadServiceInstall(db, id);
        if (install === undefined) return;
        await syncServiceSchedules(db, install, now.getTime());
        const outcome = await ensureService(bindings, install);
        pluginServiceLogger.info("Plugin service reconciled.", {
          event: "plugin_service_reconcile",
          installId: id,
          outcome: outcome.ok ? "running" : outcome.reason,
        });
      })().catch((cause: unknown) =>
        pluginServiceLogger.error("Plugin service reconcile failed.", {
          event: "plugin_service_reconcile",
          installId: id,
          outcome: "error",
          cause,
        }),
      ),
    );
  }

  for (const { id } of ids(functionSchedules)) {
    if (!id) continue;
    waitUntil(
      (async () => {
        const install = await loadRunningInstall(db, id);
        if (install === undefined || install.code.service !== undefined) return;
        await syncServiceSchedules(db, install, now.getTime());
        pluginServiceLogger.info("Plugin schedules written.", {
          event: "plugin_schedule_reconcile",
          installId: id,
          runtime: "function",
          schedules: (install.code.schedules ?? []).length,
        });
      })().catch((cause: unknown) =>
        pluginServiceLogger.error("Plugin schedule reconcile failed.", {
          event: "plugin_schedule_reconcile",
          installId: id,
          outcome: "error",
          cause,
        }),
      ),
    );
  }

  for (const row of ids(stopping)) {
    const pluginId = row.plugin_id;
    if (pluginId === null || pluginId === undefined) continue;
    waitUntil(
      (async () => {
        if (row.orb_id !== null && row.orb_id !== undefined)
          await stopService(
            bindings,
            row.orb_id as PluginOrbId,
            pluginId,
            "plugin-off",
          );
        await db.batch([
          db
            .prepare(
              "UPDATE plugin_service SET status = 'off', message = NULL, updated_at = ? WHERE plugin_id = ?",
            )
            .bind(nowIso, pluginId),
          db
            .prepare("DELETE FROM plugin_service_schedule WHERE plugin_id = ?")
            .bind(pluginId),
        ]);
        pluginServiceLogger.info("Plugin service stopped.", {
          event: "plugin_service_stop",
          installId: pluginId,
          orbId: row.orb_id,
        });
      })().catch(() => undefined),
    );
  }

  const workspaces = makeExecutionWorkspaces(bindings);
  const stopOrb = (id: string, reason: "services-off" | "payer-left") =>
    waitUntil(
      (async () => {
        const changed = await db
          .prepare(
            `UPDATE plugin_orb SET state = 'stopped', stopped_reason = ?, updated_at = ?
              WHERE id = ? AND state = 'active'`,
          )
          .bind(reason, nowIso, id)
          .run();
        if (changed.meta.changes === 0) return;
        await workspaces
          .archive(pluginOrbExecutionKey(id as PluginOrbId))
          .catch(() => undefined);
        pluginServiceLogger.info("Plugin Orb stopped.", {
          event: "plugin_orb_stopped",
          orbId: id,
          reason,
        });
      })().catch(() => undefined),
    );
  // One action per Orb a tick: removal wins over a stop, and a payer who
  // left over "nothing runs here", so the reason shown is the one to act on.
  const removing = new Set(ids(goneOrbs).flatMap(({ id }) => (id ? [id] : [])));
  const left = new Set(
    ids(leftOrbs).flatMap(({ id }) => (id && !removing.has(id) ? [id] : [])),
  );
  for (const id of left) stopOrb(id, "payer-left");
  for (const { id } of ids(idleOrbs))
    if (id && !removing.has(id) && !left.has(id)) stopOrb(id, "services-off");

  for (const { id } of ids(goneOrbs)) {
    if (!id) continue;
    waitUntil(
      (async () => {
        await db
          .prepare(
            "UPDATE plugin_orb SET state = 'removing', updated_at = ? WHERE id = ?",
          )
          .bind(nowIso, id)
          .run();
        await workspaces.destroy(pluginOrbExecutionKey(id as PluginOrbId));
        await db.batch([
          db
            .prepare(
              "UPDATE plugin_service SET orb_id = NULL, status = 'off' WHERE orb_id = ?",
            )
            .bind(id),
          db
            .prepare("DELETE FROM execution_workspace WHERE thread_id = ?")
            .bind(id),
          db.prepare("DELETE FROM plugin_orb WHERE id = ?").bind(id),
        ]);
        pluginServiceLogger.info("Plugin Orb removed.", {
          event: "plugin_orb_removed",
          orbId: id,
        });
      })().catch((cause: unknown) =>
        // Retried on the next tick: the row stays `removing`.
        pluginServiceLogger.error("Plugin Orb removal failed.", {
          event: "plugin_orb_removed",
          orbId: id,
          outcome: "error",
          cause,
        }),
      ),
    );
  }

  // A service that keeps running is ensured every minute: it keeps its Orb
  // awake, and a dxd that updated itself (which stops services) or an Orb
  // that restarted starts it again.
  for (const { id } of ids(keepAwake)) {
    if (!id) continue;
    waitUntil(
      (async () => {
        const install = await loadServiceInstall(db, id);
        if (install !== undefined) await ensureService(bindings, install);
      })().catch(() => undefined),
    );
  }
};
