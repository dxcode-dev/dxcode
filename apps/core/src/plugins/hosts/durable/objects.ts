import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../../http/types.js";
import { deleteBlobPrefix } from "./blob-prefix.js";
import { durableNamespace, durableObjectName } from "./client.js";

/**
 * Purging the plugin Durable Object host's objects, so a plugin's storage
 * and blobs never outlive what they belong to. Each object registers itself
 * in `plugin_durable_object` the first time it is used. dx purges:
 * - every object of an install when the install is removed for good;
 * - a Thread's objects when the Thread is deleted (its cleanup step);
 * - both when a workspace is deleted, which removes its installs and
 *   tombstones its Threads.
 * Each purge is idempotent and runs outside the request; the minute cron
 * ({@link sweepDurablePurges}) finishes any that failed.
 */

const logger = getLogger(["dx", "plugins", "hosts", "durable"]);

interface ObjectRow {
  readonly name: string;
  readonly install_id: string;
  readonly thread_id: string | null;
}

const purgeRows = async (
  bindings: Bindings,
  rows: ReadonlyArray<ObjectRow>,
): Promise<{ purged: number; failed: number; blobs: number }> => {
  const namespace = durableNamespace(bindings);
  const db = bindings.DB as D1Database | undefined;
  if (namespace === undefined || db === undefined)
    return { purged: 0, failed: rows.length, blobs: 0 };
  let purged = 0;
  let failed = 0;
  let blobs = 0;
  for (const row of rows) {
    try {
      const result = await namespace
        .get(namespace.idFromName(row.name))
        .purge(row.install_id, row.thread_id ?? undefined);
      blobs += result.blobs;
      logger.info("A plugin Durable Object was purged.", {
        event: "plugin_durable_object_purged",
        object: row.name,
        installId: row.install_id,
        threadId: row.thread_id,
        host: "durable",
        wasEmpty: result.wasEmpty,
        sqlBytesBefore: result.sqlBytes,
        tablesLeft: result.tablesLeft,
        blobs: result.blobs,
        outcome: "ok",
      });
      await db
        .prepare(
          "UPDATE plugin_durable_object SET purged_at = ? WHERE name = ?",
        )
        .bind(new Date().toISOString(), row.name)
        .run();
      purged += 1;
    } catch (error) {
      failed += 1;
      logger.warn("A plugin Durable Object was not purged; the cron retries.", {
        event: "plugin_durable_purge_failed",
        object: row.name,
        installId: row.install_id,
        threadId: row.thread_id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { purged, failed, blobs };
};

const select = async (
  db: D1Database,
  where: string,
  value: string,
): Promise<ReadonlyArray<ObjectRow>> =>
  (
    await db
      .prepare(
        `SELECT name, install_id, thread_id FROM plugin_durable_object
          WHERE purged_at IS NULL AND ${where} = ? LIMIT 500`,
      )
      .bind(value)
      .all<ObjectRow>()
  ).results;

/** Every object of an install, and every blob under its prefix. */
export const purgeDurableInstall = async (
  bindings: Bindings,
  installId: string,
  requestId?: string,
) => {
  const started = Date.now();
  const db = bindings.DB as D1Database | undefined;
  if (db === undefined || durableNamespace(bindings) === undefined) return;
  const result = await purgeRows(
    bindings,
    await select(db, "install_id", installId),
  );
  // Blobs of objects that never registered (stored before registration).
  const stray =
    bindings.DX_STORAGE === undefined
      ? 0
      : await deleteBlobPrefix(bindings.DX_STORAGE, `plugins/${installId}/`);
  logger.info("A removed plugin's Durable Objects were purged.", {
    event: "plugin_durable_purge",
    requestId,
    installId,
    host: "durable",
    scope: "install",
    objects: result.purged,
    failed: result.failed,
    blobs: result.blobs + stray,
    outcome: result.failed === 0 ? "ok" : "partial",
    ms: Date.now() - started,
  });
};

/** A deleted Thread's objects; its installs' own objects forget it. */
export const purgeDurableThread = async (
  bindings: Bindings,
  threadId: string,
) => {
  const started = Date.now();
  const db = bindings.DB as D1Database | undefined;
  const namespace = durableNamespace(bindings);
  if (db === undefined || namespace === undefined) return;
  const rows = await select(db, "thread_id", threadId);
  const result = await purgeRows(bindings, rows);
  for (const installId of new Set(rows.map(({ install_id }) => install_id)))
    await namespace
      .get(namespace.idFromName(durableObjectName(installId, undefined)))
      .forgetThread(threadId)
      .catch(() => undefined);
  logger.info("A deleted Thread's plugin Durable Objects were purged.", {
    event: "plugin_durable_purge",
    threadId,
    host: "durable",
    scope: "thread",
    objects: result.purged,
    failed: result.failed,
    blobs: result.blobs,
    outcome: result.failed === 0 ? "ok" : "partial",
    ms: Date.now() - started,
  });
  if (result.failed > 0)
    throw new Error(`${result.failed} plugin Durable Objects were not purged.`);
};

/** Re-enabling an install: its objects resume jobs held while it was off. */
export const resumeDurableInstall = async (
  bindings: Bindings,
  installId: string,
  requestId?: string,
) => {
  const db = bindings.DB as D1Database | undefined;
  const namespace = durableNamespace(bindings);
  if (db === undefined || namespace === undefined) return;
  let resumed = 0;
  for (const row of await select(db, "install_id", installId))
    resumed += await namespace
      .get(namespace.idFromName(row.name))
      .resumeInstall()
      .catch(() => 0);
  logger.info("A re-enabled plugin's Durable Object jobs resumed.", {
    event: "plugin_durable_resume",
    requestId,
    installId,
    host: "durable",
    jobs: resumed,
    outcome: "ok",
  });
};

/**
 * The minute cron: objects whose install was removed, or whose Thread was
 * deleted, and that are not purged yet. A few per tick.
 */
export const sweepDurablePurges = async (bindings: Bindings, limit = 20) => {
  const db = bindings.DB as D1Database | undefined;
  if (db === undefined || durableNamespace(bindings) === undefined) return 0;
  const { results } = await db
    .prepare(
      `SELECT o.name, o.install_id, o.thread_id
         FROM plugin_durable_object o
         LEFT JOIN trusted_plugin p ON p.id = o.install_id
         LEFT JOIN threads t ON t.id = o.thread_id
        WHERE o.purged_at IS NULL
          AND (p.removed_at IS NOT NULL
            OR (o.thread_id IS NOT NULL
              AND (t.id IS NULL OR t.lifecycle_state = 'deleted')))
        LIMIT ?`,
    )
    .bind(limit)
    .all<ObjectRow>();
  if (results.length === 0) return 0;
  const result = await purgeRows(bindings, results);
  logger.info("Plugin Durable Objects swept.", {
    event: "plugin_durable_purge",
    host: "durable",
    scope: "sweep",
    objects: result.purged,
    failed: result.failed,
    blobs: result.blobs,
    outcome: result.failed === 0 ? "ok" : "partial",
  });
  return result.purged;
};
