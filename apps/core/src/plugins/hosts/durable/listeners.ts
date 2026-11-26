import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { pluginRunsForOwnerSql } from "../../../settings/plugins/bundles/overlap.js";
import { durableNamespace } from "./client.js";

/**
 * The minute sweep for URL listeners (object-host.ts): every install that
 * runs and declares one gets its Durable Object's `ensure`, which opens
 * what is missing and closes what changed; every object whose install no
 * longer runs or listens is emptied and marked purged. The object's name is
 * the install's ID, and `plugin_durable_object` records each one in use.
 * Rows from before listeners (per Thread, or with SQL tables and job alarms)
 * are purged the same way.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

const ENSURE_PER_TICK = 200;
const PURGE_PER_TICK = 25;

const runsSql = pluginRunsForOwnerSql(
  "plugin",
  "CASE WHEN plugin.scope = 'personal' THEN plugin.target_id ELSE version.trusted_by_user_id END",
);

/** Installs that run now and declare a listener with a URL. */
const listeningSql = `
  SELECT plugin.id FROM trusted_plugin AS plugin
    JOIN trusted_plugin_version AS version
      ON version.plugin_id = plugin.id
     AND version.version = plugin.active_version
   WHERE plugin.kind = 'bundle'
     AND EXISTS (
       SELECT 1 FROM json_each(version.manifest_json, '$.code.listeners') AS listener
        WHERE json_type(listener.value, '$.url') = 'text')
     AND ${runsSql}`;

export const sweepPluginListeners = async (
  bindings: Bindings,
  now: Date,
  waitUntil: (promise: Promise<unknown>) => void,
) => {
  const db = bindings.DB;
  const namespace = durableNamespace(bindings);
  if (db === undefined || namespace === undefined) return;
  const nowIso = now.toISOString();
  const [listening, stale] = await db.batch([
    db.prepare(`${listeningSql} LIMIT ?`).bind(ENSURE_PER_TICK),
    db
      .prepare(
        `SELECT name FROM plugin_durable_object
          WHERE purged_at IS NULL
            AND (thread_id IS NOT NULL OR name NOT IN (${listeningSql}))
          LIMIT ?`,
      )
      .bind(PURGE_PER_TICK),
  ]);
  for (const { id } of (listening?.results ?? []) as ReadonlyArray<{
    id: string;
  }>)
    waitUntil(
      (async () => {
        await db
          .prepare(
            `INSERT INTO plugin_durable_object (name, install_id, thread_id, created_at)
             VALUES (?1, ?1, NULL, ?2)
             ON CONFLICT (name) DO UPDATE SET purged_at = NULL`,
          )
          .bind(id, nowIso)
          .run();
        await namespace.get(namespace.idFromName(id)).ensure(id);
      })().catch((cause: unknown) =>
        logger.warn(
          "A plugin's listeners did not open; the next minute retries.",
          {
            event: "plugin_listener_ensure_failed",
            installId: id,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      ),
    );
  for (const { name } of (stale?.results ?? []) as ReadonlyArray<{
    name: string;
  }>)
    waitUntil(
      (async () => {
        await namespace.get(namespace.idFromName(name)).purge();
        await db
          .prepare(
            "UPDATE plugin_durable_object SET purged_at = ? WHERE name = ?",
          )
          .bind(nowIso, name)
          .run();
        logger.info("A plugin Durable Object was emptied.", {
          event: "plugin_durable_object_purged",
          object: name,
        });
      })().catch((cause: unknown) =>
        logger.warn(
          "A plugin Durable Object was not emptied; the next minute retries.",
          {
            event: "plugin_durable_purge_failed",
            object: name,
            error: cause instanceof Error ? cause.message : String(cause),
          },
        ),
      ),
    );
};
