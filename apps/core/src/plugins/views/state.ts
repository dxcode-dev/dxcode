import {
  MAX_DATA_VIEW_STATE_BYTES,
  type PluginDataViewEntry,
  parseStatePath,
  type UserId,
  writeStatePath,
} from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import type { Bindings } from "../../http/types.js";
import {
  AUDIENCE_HEADER,
  type AudienceKey,
  CLIENT_HEADER,
  homeAudienceForUser,
  PARTICIPANT_HEADER,
  workspaceAudienceKey,
} from "../../realtime/publication.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { viewStateKey } from "./watch-token.js";

/**
 * The one store of view state: the latest state of each view described as
 * data, per install and view (`plugin_view_state`, migration 0239). Every
 * runtime that runs plugin code sets it through `setPluginViewState`: the
 * function tier's `ctx.views.set`, the durable function tier, and a
 * plugin's service (M3). Nothing else writes the table.
 *
 * A set writes one row and then tells the browsers watching the view: the
 * realtime hub of the install's audience sends the change, with its path
 * and value when they fit in {@link MAX_PUSHED_PATCH_BYTES}, to every
 * socket that holds a watch for the view. A browser that misses a version
 * reads the whole state again.
 */

const logger = getLogger(["dx", "plugins", "views"]);

/** A set retries this many times while other writes to the view land first. */
const MAX_WRITE_ATTEMPTS = 12;

/** A change at most this large rides along with its notice. */
export const MAX_PUSHED_PATCH_BYTES = 32 * 1_024;

export type ViewStateRefusal =
  | "unknown-view"
  | "bad-path"
  | "bad-value"
  | "too-large"
  | "busy";

export type SetViewStateResult =
  | { readonly ok: true; readonly version: number }
  | {
      readonly ok: false;
      readonly code: ViewStateRefusal;
      readonly message: string;
    };

export interface StoredViewState {
  readonly state: unknown;
  /** 0 before the plugin first sets it. */
  readonly version: number;
}

const encoder = new TextEncoder();

/** The install's view described as data with this id. */
export const dataViewOf = (
  install: Pick<PluginInstallRecord, "code">,
  viewId: string,
): PluginDataViewEntry | undefined =>
  install.code.dataViews?.find(({ id }) => id === viewId);

/** The view file's text, stored with the version's files. */
export const readDataViewFile = async (
  db: D1Database,
  install: Pick<PluginInstallRecord, "pluginId" | "version">,
  view: PluginDataViewEntry,
): Promise<string | undefined> => {
  const row = await db
    .prepare(
      `SELECT content, integrity FROM trusted_plugin_file
        WHERE plugin_id = ? AND version = ? AND path = ?`,
    )
    .bind(install.pluginId, install.version, view.file)
    .first<{ content: string; integrity: string }>();
  return row === null || row.integrity !== view.integrity
    ? undefined
    : row.content;
};

/** The state a view starts with: its file's `state`. */
const initialState = async (
  db: D1Database,
  install: Pick<PluginInstallRecord, "pluginId" | "version">,
  view: PluginDataViewEntry,
): Promise<unknown> => {
  const text = await readDataViewFile(db, install, view);
  if (text === undefined) return {};
  try {
    const parsed = JSON.parse(text) as { state?: unknown };
    return parsed.state ?? {};
  } catch {
    return {};
  }
};

export const readPluginViewState = async (
  db: D1Database,
  installId: string,
  viewId: string,
): Promise<StoredViewState | undefined> => {
  const row = await db
    .prepare(
      "SELECT state_json, version FROM plugin_view_state WHERE plugin_id = ? AND view_id = ?",
    )
    .bind(installId, viewId)
    .first<{ state_json: string; version: number }>();
  return row === null
    ? undefined
    : { state: JSON.parse(row.state_json) as unknown, version: row.version };
};

const refused = (
  code: ViewStateRefusal,
  message: string,
): SetViewStateResult => ({ ok: false, code, message });

/**
 * Sets the value at `path` in the view's state (`""` replaces it whole;
 * `undefined` removes the key). Refused whole, with a message an author can
 * act on, when the view is not one of the install's, the path is
 * malformed, the value is not JSON, or the state would pass 512 KB.
 */
export const setPluginViewState = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB" | "BETTER_AUTH_SECRET">,
  input: {
    readonly install: Pick<
      PluginInstallRecord,
      | "pluginId"
      | "name"
      | "version"
      | "code"
      | "scope"
      | "targetId"
      | "installedByUserId"
    >;
    readonly viewId: string;
    readonly path: string;
    readonly value: unknown;
    /** Runs the push after the response, where the runtime allows. */
    readonly waitUntil?: (promise: Promise<unknown>) => void;
  },
): Promise<SetViewStateResult> => {
  const db = bindings.DB;
  if (db === undefined)
    return refused("busy", "View state is not available here.");
  const { install, viewId, path } = input;
  const view =
    typeof viewId === "string" ? dataViewOf(install, viewId) : undefined;
  if (view === undefined)
    return refused(
      "unknown-view",
      `${install.name} has no view ${JSON.stringify(viewId)}. Its views: ${(install.code.dataViews ?? []).map(({ id }) => id).join(", ") || "none"}; declare each in the manifest's views.`,
    );
  const segments = typeof path === "string" ? parseStatePath(path) : undefined;
  if (segments === undefined)
    return refused(
      "bad-path",
      `The path ${JSON.stringify(path)} is not a state path. Use keys and list indexes joined by dots, such as stats.errors or rows.0.status, or "" for the whole state.`,
    );
  let value: unknown;
  try {
    const text = JSON.stringify(input.value);
    value = text === undefined ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return refused(
      "bad-value",
      "The value must be JSON: text, numbers, true or false, null, lists, and objects.",
    );
  }
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    // Writers to one view take turns: each retry waits a little longer.
    if (attempt > 0)
      await new Promise((resolve) =>
        setTimeout(resolve, attempt * (5 + Math.random() * 20)),
      );
    const current = await readPluginViewState(db, install.pluginId, viewId);
    const base = current?.state ?? (await initialState(db, install, view));
    const written = writeStatePath(base, segments, value);
    if (!written.ok)
      return refused("bad-path", `Cannot set ${path}: ${written.reason}.`);
    const json = JSON.stringify(written.state ?? {});
    const bytes = encoder.encode(json).byteLength;
    if (bytes > MAX_DATA_VIEW_STATE_BYTES)
      return refused(
        "too-large",
        `The view ${viewId}'s state would be ${bytes.toLocaleString("en-US")} bytes; a view's state is at most ${MAX_DATA_VIEW_STATE_BYTES.toLocaleString("en-US")}. Keep fewer rows or shorter values.`,
      );
    const now = new Date().toISOString();
    const result =
      current === undefined
        ? await db
            .prepare(
              `INSERT INTO plugin_view_state (plugin_id, view_id, state_json, version, updated_at)
               VALUES (?, ?, ?, 1, ?) ON CONFLICT DO NOTHING`,
            )
            .bind(install.pluginId, viewId, json, now)
            .run()
        : await db
            .prepare(
              `UPDATE plugin_view_state SET state_json = ?, version = version + 1, updated_at = ?
                WHERE plugin_id = ? AND view_id = ? AND version = ?`,
            )
            .bind(json, now, install.pluginId, viewId, current.version)
            .run();
    if (result.meta.changes !== 1) continue;
    const version = (current?.version ?? 0) + 1;
    const push = pushViewState(bindings, input.install, viewId, {
      version,
      path,
      value,
    });
    if (input.waitUntil === undefined) await push;
    else input.waitUntil(push);
    return { ok: true, version };
  }
  return refused(
    "busy",
    `The view ${viewId}'s state was changed by other writes ${MAX_WRITE_ATTEMPTS} times in a row; set it again.`,
  );
};

/** Where an install's browsers listen: its owner's or workspace's hub. */
const audiences = new Map<
  string,
  { readonly audience: AudienceKey; readonly at: number }
>();

const audienceOf = async (
  db: D1Database,
  install: Pick<PluginInstallRecord, "scope" | "targetId">,
): Promise<AudienceKey> => {
  if (install.scope === "workspace")
    return workspaceAudienceKey(install.targetId);
  const cached = audiences.get(install.targetId);
  if (cached !== undefined && Date.now() - cached.at < 60_000)
    return cached.audience;
  const audience = await homeAudienceForUser(db, install.targetId as UserId);
  audiences.set(install.targetId, { audience, at: Date.now() });
  return audience;
};

/** Tells the browsers watching a view about one change; drafts use it too. */
export const pushViewState = async (
  bindings: Pick<Bindings, "DB" | "REALTIME_HUB">,
  install: Pick<
    PluginInstallRecord,
    "pluginId" | "scope" | "targetId" | "installedByUserId"
  >,
  viewId: string,
  change: {
    readonly version: number;
    readonly path: string;
    readonly value: unknown;
  },
) => {
  if (bindings.DB === undefined || bindings.REALTIME_HUB === undefined) return;
  try {
    const audience = await audienceOf(bindings.DB, install);
    const patch = JSON.stringify({ path: change.path, value: change.value });
    const response = await bindings.REALTIME_HUB.getByName(audience).fetch(
      "https://realtime.internal/view-state",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          [AUDIENCE_HEADER]: audience,
          [PARTICIPANT_HEADER]:
            install.scope === "personal"
              ? install.targetId
              : (install.installedByUserId ?? "plugin"),
          [CLIENT_HEADER]: crypto.randomUUID(),
        },
        body: JSON.stringify({
          key: viewStateKey(install.pluginId, viewId),
          version: change.version,
          ...(encoder.encode(patch).byteLength <= MAX_PUSHED_PATCH_BYTES
            ? { patch: { path: change.path, value: change.value } }
            : {}),
        }),
      },
    );
    if (!response.ok)
      throw new Error(`Realtime hub returned ${response.status}.`);
  } catch (cause) {
    logger.warn("Plugin view state push failed.", {
      event: "plugin_view_state_push_failed",
      installId: install.pluginId,
      viewId,
      cause,
    });
  }
};
