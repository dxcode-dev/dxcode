import { PluginAppsResponseSchema, PluginAppUrlResponseSchema } from "@dx/api";
import { getLogger } from "@logtape/logtape";
import { Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { pluginAppUrl } from "../services/app.js";
import { listOwnerCodePluginInstalls } from "../worker-host/resolve.js";

/**
 * A plugin's own web app (`service.app`), at `/v1/plugins/views/apps`:
 *
 * - `GET /apps`: the caller's installs that have one, read from the
 *   manifests their installs already carry (one D1 read, no Orb).
 * - `GET /:plugin/app`: where a frame loads it now. M3's `pluginAppUrl`
 *   checks the viewer may use the install, starts its program on its plugin
 *   Orb if needed, and returns a short-lived Portal URL that reaches only
 *   the app's path. No secret is ever in it.
 *
 * Each request logs one `plugin_app` line with its requestId.
 */

const logger = getLogger(["dx", "plugins", "views"]);

const appOf = (install: { readonly code: unknown }) =>
  (install.code as { service?: { app?: { path?: string } } }).service?.app;

const refuse = (
  context: Context<AppEnv>,
  status: 404 | 503,
  message: string,
) => {
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error" as const,
      data: {
        code:
          status === 404 ? "PLUGIN_APP_NOT_FOUND" : "PLUGIN_APP_UNAVAILABLE",
        message,
        requestId: context.get("requestId"),
      },
    },
    status,
  );
};

export const pluginAppRoutes = new Hono<AppEnv>()
  .get("/apps", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    const installs =
      db === undefined
        ? []
        : await listOwnerCodePluginInstalls(
            db,
            context.get("principal").userId,
          );
    const apps = installs.flatMap((install) =>
      install.scope === "repository" || appOf(install) === undefined
        ? []
        : [
            {
              plugin: install.name,
              title: install.displayName,
              ...(install.code.dataViews?.[0]?.icon === undefined
                ? {}
                : { icon: install.code.dataViews[0].icon }),
            },
          ],
    );
    logger.info("Plugin apps listed.", {
      event: "plugin_app",
      route: "list",
      requestId: context.get("requestId"),
      apps: apps.length,
      outcome: "success",
      ms: Date.now() - started,
    });
    context.header("Cache-Control", "private, max-age=60");
    return context.json(
      Schema.encodeUnknownSync(PluginAppsResponseSchema)({
        status: "success",
        data: { apps },
      }),
    );
  })
  .get("/:plugin/app", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    const viewerUserId = context.get("principal").userId;
    const plugin = context.req.param("plugin");
    const install =
      db === undefined
        ? undefined
        : (await listOwnerCodePluginInstalls(db, viewerUserId)).find(
            (candidate) =>
              candidate.name === plugin && candidate.scope !== "repository",
          );
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      logger.info("Plugin app opened.", {
        event: "plugin_app",
        route: "open",
        requestId: context.get("requestId"),
        plugin,
        installId: install?.pluginId,
        outcome,
        ms: Date.now() - started,
        ...extra,
      });
    if (install === undefined || appOf(install) === undefined) {
      log("not-found");
      return refuse(
        context,
        404,
        "No installed plugin of yours has this page. Its plugin may be off or removed.",
      );
    }
    const opened = await pluginAppUrl(context.env, { install, viewerUserId });
    if ("error" in opened) {
      log(`refused:${opened.error.code}`);
      return refuse(
        context,
        opened.error.code === "not-found" || opened.error.code === "no-app"
          ? 404
          : 503,
        opened.error.message,
      );
    }
    log("success");
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(PluginAppUrlResponseSchema)({
        status: "success",
        data: {
          url: opened.url,
          expiresAt: opened.expiresAt,
          title: install.displayName,
          ...(install.code.dataViews?.[0]?.icon === undefined
            ? {}
            : { icon: install.code.dataViews[0].icon }),
        },
      }),
    );
  });
