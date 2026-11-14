import {
  type PluginPageEntry,
  PluginPageViewResponseSchema,
  type PluginThreadTypeOption,
  PluginViewsCatalogResponseSchema,
  type PluginViewsErrorCode,
  PostPluginPaneMessageRequestSchema,
  PostPluginPaneMessageResponseSchema,
} from "@dx/api";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { readBoundedText } from "../../http/bounded-body.js";
import type { AppEnv } from "../../http/types.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { listOwnerCodePluginInstalls } from "../worker-host/resolve.js";
import { describePlugin, sendPaneMessage } from "../worker-host/worker.js";
import { installTier, showsViews } from "./tier.js";

/**
 * Plugin pages, mounted at `/v1/plugins/views`. A page is a plugin's
 * full-page view outside any Thread, at `/plugins/<name>/<id><path>` in
 * the web app. Everything here is the caller's own: their personal installs
 * and their workspaces' installs, as a new Thread of theirs would run.
 *
 * - `GET /`: the caller's pages and Thread types, read from the manifests
 *   of their installs in one D1 read; no plugin code starts.
 * - `GET /:plugin/pages/:page`: the page's view (starts or reuses the
 *   plugin's worker, which describes itself once per isolate).
 * - `POST /:plugin/pages/:page/messages`: the view's `dx/plugin.post`,
 *   which runs its `onMessage` with no Thread. At most
 *   {@link PAGE_CALLS_PER_MINUTE} a minute per plugin and person; each is a
 *   `page.message` audit row, which is also the rate limit's count.
 *
 * Each request logs one `plugin_view` line with its requestId.
 */

const logger = getLogger(["dx", "plugins", "views"]);

/** A page's view sends its plugin at most this many messages a minute. */
export const PAGE_CALLS_PER_MINUTE = 60;

const MAX_BODY_BYTES = 256 * 1_024;

const MESSAGES: Record<PluginViewsErrorCode, [number, string]> = {
  INVALID_REQUEST: [400, "Request validation failed."],
  PLUGIN_PAGE_NOT_FOUND: [
    404,
    "No installed plugin of yours offers that page. Its plugin may be off, removed, or not trusted to show pages.",
  ],
  PLUGIN_PAGE_FAILED: [502, "The plugin's page could not answer."],
};

const refuse = (
  context: Context<AppEnv>,
  code: PluginViewsErrorCode,
  detail?: string,
) => {
  const [status, message] = MESSAGES[code];
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error" as const,
      data: {
        code,
        message,
        requestId: context.get("requestId"),
        ...(detail === undefined ? {} : { detail }),
      },
    },
    status as 400,
  );
};

const logView = (
  context: Context<AppEnv>,
  started: number,
  properties: {
    readonly route: string;
    readonly outcome: string;
    readonly install?: PluginInstallRecord;
    readonly plugin?: string;
    readonly page?: string;
    readonly error?: string;
  },
) => {
  const { install, ...rest } = properties;
  const line = {
    event: "plugin_view",
    requestId: context.get("requestId"),
    ...rest,
    ...(install === undefined
      ? {}
      : { installId: install.pluginId, tier: installTier(install) }),
    host: "worker",
    ms: Date.now() - started,
  };
  if (properties.outcome === "success")
    logger.info(`Plugin view ${properties.route}.`, line);
  else
    logger.warn(`Plugin view ${properties.route} ${properties.outcome}.`, line);
};

/** The caller's install that offers the page, at a tier that shows pages. */
const findPage = async (context: Context<AppEnv>, db: D1Database) => {
  const name = context.req.param("plugin") ?? "";
  const id = context.req.param("page") ?? "";
  const installs = await listOwnerCodePluginInstalls(
    db,
    context.get("principal").userId,
  );
  const install = installs.find((candidate) => candidate.name === name);
  const page = install?.code.views?.pages.find(
    (candidate) => candidate.id === id,
  );
  if (install === undefined || page === undefined)
    return { ok: false as const, reason: "not-found" as const, install };
  if (!showsViews(install))
    return { ok: false as const, reason: "tier" as const, install };
  return { ok: true as const, install, page, installs };
};

/** The request's `waitUntil`, where the runtime gives one. */
const requestWaitUntil = (context: Context<AppEnv>) => {
  try {
    const execution = context.executionCtx;
    return {
      waitUntil: (promise: Promise<unknown>) =>
        execution.waitUntil(promise.catch(() => undefined)),
    };
  } catch {
    return {};
  }
};

const encoder = new TextEncoder();

/** A weak validator for a JSON body: same body, same tag. */
const etagOf = async (json: string) => {
  const digest = new Uint8Array(
    await crypto.subtle.digest("SHA-256", encoder.encode(json)),
  );
  return `W/"${Array.from(digest.slice(0, 12), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
};

export const pluginViewRoutes = new Hono<AppEnv>()
  .get("/", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    const installs =
      db === undefined
        ? []
        : await listOwnerCodePluginInstalls(
            db,
            context.get("principal").userId,
          );
    const pages: PluginPageEntry[] = [];
    const threadTypes: PluginThreadTypeOption[] = [];
    for (const install of installs) {
      const views = install.code.views;
      if (views === undefined || !showsViews(install)) continue;
      for (const page of views.pages)
        pages.push({
          plugin: install.name,
          page: page.id,
          title: page.title,
          pluginTitle: install.displayName,
          path: page.path,
          ...(page.icon === undefined ? {} : { icon: page.icon }),
        });
      for (const type of views.threadTypes)
        threadTypes.push({
          ref: `${install.name}/${type.id}`,
          plugin: install.name,
          type: type.id,
          title: type.title,
          pluginTitle: install.displayName,
          chat: type.chat,
          ...(type.icon === undefined ? {} : { icon: type.icon }),
        });
    }
    const json = JSON.stringify(
      Schema.encodeUnknownSync(PluginViewsCatalogResponseSchema)({
        status: "success",
        data: { pages, threadTypes },
      }),
    );
    const etag = await etagOf(json);
    // Private to the caller; revalidated after a minute, or at once by the
    // web app after an install changes.
    context.header("Cache-Control", "private, max-age=60");
    context.header("ETag", etag);
    context.header("Vary", "Cookie, Authorization");
    logView(context, started, {
      route: "catalog",
      outcome: "success",
    });
    if (context.req.header("If-None-Match") === etag)
      return context.body(null, 304);
    context.header("Content-Type", "application/json");
    return context.body(json);
  })
  .get("/:plugin/pages/:page", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    if (db === undefined) return refuse(context, "INVALID_REQUEST");
    const found = await findPage(context, db);
    const plugin = context.req.param("plugin");
    const pageId = context.req.param("page");
    if (!found.ok) {
      logView(context, started, {
        route: "page",
        outcome: found.reason === "tier" ? "refused:tier" : "refused:not-found",
        plugin,
        page: pageId,
        ...(found.install === undefined ? {} : { install: found.install }),
      });
      return refuse(context, "PLUGIN_PAGE_NOT_FOUND");
    }
    let view: { html: string; handlesMessages: boolean } | undefined;
    try {
      view = (await describePlugin(context.env, db, found.install)).views.find(
        ({ id }) => id === found.page.id,
      );
    } catch (error) {
      const detail =
        error instanceof Error ? error.message.slice(0, 500) : undefined;
      logView(context, started, {
        route: "page",
        outcome: "failed",
        install: found.install,
        page: pageId,
        ...(detail === undefined ? {} : { error: detail }),
      });
      return refuse(context, "PLUGIN_PAGE_FAILED", detail);
    }
    if (view === undefined) {
      logView(context, started, {
        route: "page",
        outcome: "refused:no-view",
        install: found.install,
        page: pageId,
      });
      return refuse(
        context,
        "PLUGIN_PAGE_NOT_FOUND",
        `${found.install.name} declares the page ${found.page.id} but its code registered no view with that id.`,
      );
    }
    logView(context, started, {
      route: "page",
      outcome: "success",
      install: found.install,
      page: pageId,
    });
    // A new plugin version is new HTML; the page asks again after a minute.
    context.header("Cache-Control", "private, no-cache");
    return context.json(
      Schema.encodeUnknownSync(PluginPageViewResponseSchema)({
        status: "success",
        data: {
          html: view.html,
          version: found.install.version,
          title: found.page.title,
          pluginTitle: found.install.displayName,
          ...(found.page.icon === undefined ? {} : { icon: found.page.icon }),
          handlesMessages: view.handlesMessages,
        },
      }),
    );
  })
  .post("/:plugin/pages/:page/messages", async (context) => {
    const started = Date.now();
    const db = context.env.DB;
    if (db === undefined) return refuse(context, "INVALID_REQUEST");
    let message: unknown;
    try {
      const text = await readBoundedText(context.req.raw, MAX_BODY_BYTES);
      const decoded =
        text === undefined
          ? Option.none()
          : Schema.decodeUnknownOption(PostPluginPaneMessageRequestSchema)(
              JSON.parse(text) as unknown,
            );
      if (Option.isNone(decoded)) return refuse(context, "INVALID_REQUEST");
      message = decoded.value.message ?? null;
    } catch {
      return refuse(context, "INVALID_REQUEST");
    }
    if (JSON.stringify(message).length > 65_536)
      return refuse(context, "INVALID_REQUEST");
    const found = await findPage(context, db);
    if (!found.ok) {
      logView(context, started, {
        route: "page-message",
        outcome: found.reason === "tier" ? "refused:tier" : "refused:not-found",
        plugin: context.req.param("plugin"),
        page: context.req.param("page"),
        ...(found.install === undefined ? {} : { install: found.install }),
      });
      return refuse(context, "PLUGIN_PAGE_NOT_FOUND");
    }
    const { install, page, installs } = found;
    const ownerUserId = context.get("principal").userId;
    const requestId = context.get("requestId");
    // The audit row is the rate limit's count: written only while under it.
    const now = new Date();
    const admitted = await db
      .prepare(
        `INSERT INTO plugin_audit (
           id, plugin_id, plugin_name, plugin_version, scope, owner_user_id,
           thread_id, action, target, outcome, detail_json, created_at)
         SELECT ?1, ?2, ?3, ?4, ?5, ?6, NULL, 'page.message', ?7, 'success', ?8, ?9
          WHERE (SELECT count(*) FROM plugin_audit
                  WHERE plugin_id = ?2 AND created_at > ?10
                    AND action = 'page.message' AND owner_user_id = ?6) < ?11`,
      )
      .bind(
        `pla_${crypto.randomUUID()}`,
        install.pluginId,
        install.name.slice(0, 214),
        install.version.slice(0, 160),
        install.scope,
        ownerUserId,
        page.id,
        JSON.stringify({ requestId }),
        now.toISOString(),
        new Date(now.getTime() - 60_000).toISOString(),
        PAGE_CALLS_PER_MINUTE,
      )
      .run();
    if ((admitted.meta.changes ?? 0) === 0) {
      logView(context, started, {
        route: "page-message",
        outcome: "refused:rate-limit",
        install,
        page: page.id,
      });
      return refuse(
        context,
        "PLUGIN_PAGE_FAILED",
        `A plugin's page sends it at most ${PAGE_CALLS_PER_MINUTE} messages a minute.`,
      );
    }
    const run = sendPaneMessage(
      {
        db,
        bindings: context.env,
        install,
        ownerUserId,
        ...(requestId === undefined ? {} : { requestId }),
        // A plugin call from the page reaches the installs loaded here.
        peers: async () => installs,
        // A Thread the page starts keeps delivering its first message
        // after this response; without a request context, threads.create
        // waits for it instead.
        ...requestWaitUntil(context),
      },
      page.id,
      message,
    );
    try {
      context.executionCtx.waitUntil(run.catch(() => undefined));
    } catch {
      // No request context (tests): the call already runs.
    }
    try {
      const result = await run;
      logView(context, started, {
        route: "page-message",
        outcome: "success",
        install,
        page: page.id,
      });
      context.header("Cache-Control", "no-store");
      return context.json(
        Schema.encodeUnknownSync(PostPluginPaneMessageResponseSchema)({
          status: "success",
          data: { result: result ?? null },
        }),
      );
    } catch (error) {
      const detail =
        error instanceof Error && error.message !== ""
          ? error.message.slice(0, 500)
          : undefined;
      logView(context, started, {
        route: "page-message",
        outcome: "failed",
        install,
        page: page.id,
        ...(detail === undefined ? {} : { error: detail }),
      });
      return refuse(context, "PLUGIN_PAGE_FAILED", detail);
    }
  });
