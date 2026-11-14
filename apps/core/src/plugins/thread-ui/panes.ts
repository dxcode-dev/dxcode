import {
  PLUGIN_PANE_MAX_MESSAGE_BYTES,
  PLUGIN_PANE_MESSAGES_KEPT,
  PLUGIN_PANE_OPEN_SECONDS,
  PLUGIN_PANE_POSTS_PER_MINUTE,
  type PluginPaneMessage,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { Bindings } from "../../http/types.js";
import { publishRealtimeInvalidation } from "../../realtime/publication.js";
import { PluginUiLimit } from "./store.js";

/**
 * The rows behind plugin panes (migration 0172). `ctx.panes.get(id).post`
 * adds a post every open copy of the pane reads after the last one it
 * showed; `open()` adds an open request the Thread's pages act on. Panes are
 * named by the plugin's manifest name, as their tabs are.
 */

/** A plugin asks to open its panes at most this often a minute per Thread. */
export const PANE_OPENS_PER_MINUTE = 10;
/** A plugin's panes send it at most this many messages a minute per Thread. */
export const PANE_CALLS_PER_MINUTE = 60;

const LIMITS = {
  post: PLUGIN_PANE_POSTS_PER_MINUTE,
  open: PANE_OPENS_PER_MINUTE,
  call: PANE_CALLS_PER_MINUTE,
} as const;

export const invalidatePluginPanes = (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  threadId: string,
) =>
  publishRealtimeInvalidation(
    bindings,
    threadId as ThreadId,
    "plugin-pane.invalidated",
  );

/** A post as stored: JSON within the size limit. */
export const paneMessageJson = (message: unknown) => {
  const json = JSON.stringify(message ?? null);
  if (new TextEncoder().encode(json).byteLength > PLUGIN_PANE_MAX_MESSAGE_BYTES)
    throw new Error(
      `A pane message is at most ${PLUGIN_PANE_MAX_MESSAGE_BYTES / 1_024} KB of JSON.`,
    );
  return json;
};

/**
 * Drops the pane's posts past the latest kept ones, once they are a minute
 * old (the rate limit counts them until then), open requests a day old,
 * and calls a minute old.
 */
const prune = (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginName: string;
    readonly paneId: string;
  },
  now: Date,
) => [
  db
    .prepare(
      `DELETE FROM plugin_pane_event
        WHERE thread_id = ?1 AND plugin_name = ?2 AND pane_id = ?3
          AND kind = 'post' AND created_at < ?4
          AND seq NOT IN (
            SELECT seq FROM plugin_pane_event
             WHERE thread_id = ?1 AND plugin_name = ?2 AND pane_id = ?3
               AND kind = 'post'
             ORDER BY seq DESC LIMIT ?5)`,
    )
    .bind(
      input.threadId,
      input.pluginName,
      input.paneId,
      new Date(now.getTime() - 60_000).toISOString(),
      PLUGIN_PANE_MESSAGES_KEPT,
    ),
  db
    .prepare(
      `DELETE FROM plugin_pane_event
        WHERE thread_id = ? AND kind = 'open' AND created_at < ?`,
    )
    .bind(input.threadId, new Date(now.getTime() - 86_400_000).toISOString()),
  db
    .prepare(
      `DELETE FROM plugin_pane_event
        WHERE thread_id = ? AND kind = 'call' AND created_at < ?`,
    )
    .bind(input.threadId, new Date(now.getTime() - 60_000).toISOString()),
];

/**
 * Adds a post, an open request, or a view's call for one of the plugin's
 * panes; refuses one past the plugin's rate limit in the Thread.
 */
export const insertPaneEvent = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly pluginName: string;
    readonly paneId: string;
    readonly kind: "post" | "open" | "call";
    readonly messageJson?: string;
    /**
     * Posts and calls a minute at the plugin's trust tier
     * (`paneMessagesPerMinute`); opens keep their own limit.
     */
    readonly perMinute?: number;
  },
) => {
  const now = new Date();
  const limit =
    input.kind === "open" || input.perMinute === undefined
      ? LIMITS[input.kind]
      : input.perMinute;
  const [inserted] = await db.batch([
    db
      .prepare(
        `INSERT INTO plugin_pane_event
           (thread_id, plugin_id, plugin_name, pane_id, kind, message_json,
            created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7
          WHERE (SELECT count(*) FROM plugin_pane_event
                  WHERE thread_id = ?1 AND plugin_id = ?2 AND kind = ?5
                    AND created_at > ?8) < ?9`,
      )
      .bind(
        input.threadId,
        input.pluginId,
        input.pluginName,
        input.paneId,
        input.kind,
        input.messageJson ?? null,
        now.toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
        limit,
      ),
    ...prune(db, input, now),
  ]);
  if ((inserted?.meta.changes ?? 0) === 0)
    throw new PluginUiLimit(
      input.kind === "post"
        ? `A plugin posts to its panes at most ${limit} times a minute in a Thread.`
        : input.kind === "open"
          ? `A plugin opens its panes at most ${limit} times a minute in a Thread.`
          : `A plugin's panes send it at most ${limit} messages a minute in a Thread.`,
    );
};

/**
 * The pane's kept posts in the Thread after `after`, oldest first: the
 * latest 20, and every post from the last minute, so a burst between two
 * reads of an open pane loses nothing.
 */
export const listPaneMessages = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginName: string;
    readonly paneId: string;
    readonly after: number;
  },
): Promise<PluginPaneMessage[]> => {
  const rows = await db
    .prepare(
      `SELECT seq, message_json FROM (
         SELECT seq, message_json, created_at,
                row_number() OVER (ORDER BY seq DESC) AS newest
           FROM plugin_pane_event
          WHERE thread_id = ?1 AND plugin_name = ?2 AND pane_id = ?3
            AND kind = 'post' AND seq > ?4)
        WHERE newest <= ?5 OR created_at > ?6
        ORDER BY seq`,
    )
    .bind(
      input.threadId,
      input.pluginName,
      input.paneId,
      input.after,
      PLUGIN_PANE_MESSAGES_KEPT,
      new Date(Date.now() - 60_000).toISOString(),
    )
    .all<{ seq: number; message_json: string | null }>();
  return rows.results.map((row) => ({
    seq: row.seq,
    message:
      row.message_json === null
        ? null
        : (JSON.parse(row.message_json) as unknown),
  }));
};

/** Each pane's latest open request in the Thread, if recent, by `plugin/pane`. */
export const recentPaneOpens = async (db: D1Database, threadId: string) => {
  const rows = await db
    .prepare(
      `SELECT plugin_name, pane_id, max(created_at) AS opened_at
         FROM plugin_pane_event
        WHERE thread_id = ? AND kind = 'open' AND created_at > ?
        GROUP BY plugin_name, pane_id`,
    )
    .bind(
      threadId,
      new Date(Date.now() - PLUGIN_PANE_OPEN_SECONDS * 1_000).toISOString(),
    )
    .all<{ plugin_name: string; pane_id: string; opened_at: string }>();
  return new Map(
    rows.results.map((row) => [
      `${row.plugin_name}/${row.pane_id}`,
      row.opened_at,
    ]),
  );
};

// --- Pane snapshots for archived Threads ---

/** Replaces the pane's saved state in the Thread (migration 0187). */
export const savePaneSnapshot = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginId: string;
    readonly pluginName: string;
    readonly paneId: string;
    readonly stateJson: string;
  },
) => {
  await db
    .prepare(
      `INSERT INTO plugin_pane_snapshot
         (thread_id, plugin_name, pane_id, plugin_id, state_json, updated_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6)
       ON CONFLICT (thread_id, plugin_name, pane_id) DO UPDATE
         SET plugin_id = excluded.plugin_id,
             state_json = excluded.state_json,
             updated_at = excluded.updated_at`,
    )
    .bind(
      input.threadId,
      input.pluginName,
      input.paneId,
      input.pluginId,
      input.stateJson,
      new Date().toISOString(),
    )
    .run();
};

/**
 * The pane's saved state as the one message an archived Thread shows, or
 * none when the plugin never saved one.
 */
export const readPaneSnapshot = async (
  db: D1Database,
  input: {
    readonly threadId: string;
    readonly pluginName: string;
    readonly paneId: string;
  },
): Promise<PluginPaneMessage[]> => {
  const row = await db
    .prepare(
      `SELECT state_json FROM plugin_pane_snapshot
        WHERE thread_id = ? AND plugin_name = ? AND pane_id = ?`,
    )
    .bind(input.threadId, input.pluginName, input.paneId)
    .first<{ state_json: string }>();
  return row === null
    ? []
    : [{ seq: 1, message: JSON.parse(row.state_json) as unknown }];
};
