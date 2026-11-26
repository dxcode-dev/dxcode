import {
  type PluginThreadTypeOption,
  PluginViewsCatalogResponseSchema,
} from "@dx/api";
import { getLogger } from "@logtape/logtape";
import { Schema } from "effect";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { listOwnerCodePluginInstalls } from "../worker-host/resolve.js";
import { dataViewOptions } from "./data-routes.js";

/**
 * The views catalog, mounted at `/v1/plugins/views`. Everything here is the
 * caller's own: their personal installs and their workspaces' installs, as
 * a new Thread of theirs would run.
 *
 * - `GET /`: the caller's views described as data that show as a page or an
 *   app, and the Thread types those apps make, read from the manifests of
 *   their installs in one D1 read; no plugin code starts.
 *
 * Each request logs one `plugin_view` line with its requestId.
 */

const logger = getLogger(["dx", "plugins", "views"]);

const encoder = new TextEncoder();

/** A weak validator for a JSON body: same body, same tag. */
const etagOf = async (json: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(json)),
  );
  return `W/"${Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
};

export const pluginViewRoutes = new Hono<AppEnv>().get("/", async (context) => {
  const started = Date.now();
  const db = context.env.DB;
  const installs =
    db === undefined
      ? []
      : await listOwnerCodePluginInstalls(db, context.get("principal").userId);
  const threadTypes: PluginThreadTypeOption[] = [];
  const dataViews = installs.flatMap((install) =>
    dataViewOptions(install, ["page", "app"]),
  );
  // Views that show as an app start Threads of their own type.
  for (const install of installs)
    if (install.scope !== "repository")
      for (const view of install.code.dataViews ?? [])
        if (view.show.includes("app"))
          threadTypes.push({
            ref: `${install.name}/${view.id}`,
            plugin: install.name,
            type: view.id,
            title: view.title,
            pluginTitle: install.displayName,
            chat: "side",
            ...(view.icon === undefined ? {} : { icon: view.icon }),
          });
  const json = JSON.stringify(
    Schema.encodeUnknownSync(PluginViewsCatalogResponseSchema)({
      status: "success",
      data: { threadTypes, dataViews },
    }),
  );
  const etag = await etagOf(json);
  // Private to the caller; revalidated after a minute, or at once by the
  // web app after an install changes.
  context.header("Cache-Control", "private, max-age=60");
  context.header("ETag", etag);
  context.header("Vary", "Cookie, Authorization");
  logger.info("Plugin view catalog.", {
    event: "plugin_view",
    requestId: context.get("requestId"),
    route: "catalog",
    outcome: "success",
    host: "worker",
    ms: Date.now() - started,
  });
  if (context.req.header("If-None-Match") === etag)
    return context.body(null, 304);
  context.header("Content-Type", "application/json");
  return context.body(json);
});
