import type { Bindings } from "../../http/types.js";
import { portalConfiguration, portalOrigin } from "../../portals/host.js";
import { activeMemberSql } from "../../settings/members/membership-sql.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { ensureService } from "./host.js";
import { loadServiceInstall } from "./installs.js";
import { pluginOrbExecutionKey } from "./orb-owner.js";

/**
 * A plugin's own page (`service.app.path`), served by its program on its
 * plugin Orb and opened in a frame under a dx header (M4's full-page app).
 * The browser reaches it through the plugin Orb's Portal on the program's
 * port, path-limited to `app.path`: the Portal lets in only a person who
 * may use an install placed there that declares a page, and a session for
 * it reaches nothing else the program answers (its tools, jobs, events).
 * No secret or `DX_TOKEN` is ever in the URL.
 */

export type PluginAppUrl =
  | { readonly url: string; readonly expiresAt: number }
  | { readonly error: { readonly code: string; readonly message: string } };

/** How long a returned URL is offered; the Portal session itself lasts 12 h. */
const OFFER_MS = 5 * 60_000;

const viewerMaySee = async (
  db: D1Database,
  install: Pick<PluginInstallRecord, "scope" | "targetId">,
  viewerUserId: string,
) =>
  install.scope === "personal"
    ? install.targetId === viewerUserId
    : install.scope === "workspace" &&
      (
        await db
          .prepare(`SELECT ${activeMemberSql("?1", "?2")} AS member`)
          .bind(install.targetId, viewerUserId)
          .first<{ member: number }>()
      )?.member === 1;

/** How long opening a page waits for its program to start, and how often it asks. */
const START_WAIT_MS = 30_000;
const START_POLL_MS = 1_000;

export const pluginAppUrl = async (
  bindings: Bindings,
  input: {
    readonly install: Pick<
      PluginInstallRecord,
      "pluginId" | "scope" | "targetId" | "displayName"
    >;
    readonly viewerUserId: string;
  },
): Promise<PluginAppUrl> => {
  const db = bindings.DB;
  const configuration = portalConfiguration(bindings);
  if (db === undefined || configuration === undefined)
    return {
      error: {
        code: "unavailable",
        message: "This deployment has no Portals, so plugin pages cannot open.",
      },
    };
  if (!(await viewerMaySee(db, input.install, input.viewerUserId)))
    return { error: { code: "not-found", message: "No such plugin page." } };
  const install = await loadServiceInstall(db, input.install.pluginId);
  const path = install?.code.service?.app?.path;
  if (install === undefined || path === undefined)
    return {
      error: {
        code: "no-app",
        message: `${input.install.displayName} has no page of its own.`,
      },
    };
  // On a cold Orb dxd starts the program and says "starting"; the Portal
  // lets the page in only once the row says it runs on its port, so ask
  // again until it does (each ensure records what dxd says).
  let ensured = await ensureService(bindings, install);
  const deadline = Date.now() + START_WAIT_MS;
  while (
    ensured.ok &&
    (ensured.value as { state?: unknown }).state !== "running" &&
    Date.now() < deadline
  ) {
    await new Promise((resolve) => setTimeout(resolve, START_POLL_MS));
    ensured = await ensureService(bindings, install);
  }
  if (!ensured.ok)
    return { error: { code: ensured.reason, message: ensured.message } };
  const port = (ensured.value as { port?: unknown }).port;
  if (
    typeof port !== "number" ||
    (ensured.value as { state?: unknown }).state !== "running"
  )
    return {
      error: {
        code: "failed",
        message: `${install.displayName}'s program is not listening yet. Try again.`,
      },
    };
  return {
    url: `${portalOrigin(configuration, pluginOrbExecutionKey(ensured.orb.id), port)}${path}`,
    expiresAt: Date.now() + OFFER_MS,
  };
};

/**
 * The page a Portal on plugin Orb `orbId` and `port` may serve to `userId`:
 * an install placed on that Orb, running on that port, declaring
 * `service.app`, that the person may use. Read only for an ID no Thread has.
 */
export const pluginAppPortal = async (
  db: D1Database,
  userId: string,
  orbId: string,
  port: number,
): Promise<{ readonly path: string } | undefined> => {
  const row = await db
    .prepare(
      `SELECT json_extract(version.manifest_json, '$.code.service.app.path') AS path
         FROM plugin_service AS service
         JOIN trusted_plugin AS plugin ON plugin.id = service.plugin_id
         JOIN trusted_plugin_version AS version
           ON version.plugin_id = plugin.id
          AND version.version = plugin.active_version
        WHERE service.orb_id = ?1 AND service.port = ?3
          AND service.status = 'running'
          AND plugin.enabled = 1 AND plugin.removed_at IS NULL
          AND json_type(version.manifest_json, '$.code.service.app') = 'object'
          AND ((plugin.scope = 'personal' AND plugin.target_id = ?2)
            OR (plugin.scope = 'workspace'
              AND ${activeMemberSql("plugin.target_id", "?2")}))
        LIMIT 1`,
    )
    .bind(orbId, userId, port)
    .first<{ path: string | null }>()
    .catch(() => null);
  return typeof row?.path === "string" ? { path: row.path } : undefined;
};
