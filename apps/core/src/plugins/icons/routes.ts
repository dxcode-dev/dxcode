import { getLogger } from "@logtape/logtape";
import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";
import { lucideIconSvg } from "./lucide.js";
import { readPluginIcon } from "./store.js";

/**
 * `GET /v1/plugins/icons/:sha256`: a plugin icon file by the hash of its
 * bytes. A hash always names the same bytes, so the answer is cached for a
 * year everywhere, and Cloudflare's cache answers repeats without D1. It is
 * served before sign-in: the hash is only known to someone shown the icon,
 * and the same hash is the same picture for everyone. SVGs were rebuilt from
 * an allowlist at install and are served with a CSP that runs nothing.
 */

const logger = getLogger(["dx", "plugins", "icons"]);

const HASH = /^[0-9a-f]{64}$/;

const IMMUTABLE = "public, max-age=31536000, immutable";

/** Cloudflare's edge cache, absent in tests and local Node runs. */
const edgeCache = (): Cache | undefined =>
  (globalThis as { caches?: { default?: Cache } }).caches?.default;

const iconHeaders = (mediaType: string, requestId: string) => ({
  "X-Request-Id": requestId,
  "Content-Type": mediaType,
  "Cache-Control": IMMUTABLE,
  "Content-Security-Policy":
    "default-src 'none'; style-src 'unsafe-inline'; sandbox",
  "X-Content-Type-Options": "nosniff",
  "Cross-Origin-Resource-Policy": "same-site",
});

export const pluginIconRoutes = new Hono<AppEnv>()
  // `lucide:<name>` item icons, drawn from dx's copy of Lucide. A name's
  // drawing may change when dx upgrades Lucide, so it is cached a day.
  .get("/lucide/:name", async (context) => {
    const started = Date.now();
    const name = context.req.param("name");
    const svg = /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)
      ? await lucideIconSvg(name)
      : undefined;
    logger.info("Plugin icon served.", {
      event: "plugin_icon_served",
      requestId: context.get("requestId"),
      lucide: name,
      outcome: svg === undefined ? "not-found" : "lucide",
      ms: Date.now() - started,
    });
    if (svg === undefined) {
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          status: "error",
          data: {
            code: "NOT_FOUND",
            message: "dx has no Lucide icon with that name.",
            requestId: context.get("requestId"),
          },
        },
        404,
      );
    }
    return new Response(svg, {
      headers: {
        ...iconHeaders("image/svg+xml", context.get("requestId")),
        "Cache-Control": "public, max-age=86400",
      },
    });
  })
  .get("/:sha256", async (context) => {
    const started = Date.now();
    const requestId = context.get("requestId");
    const hash = context.req.param("sha256");
    const log = (outcome: string, extra: Record<string, unknown> = {}) =>
      logger.info("Plugin icon served.", {
        event: "plugin_icon_served",
        requestId,
        hash,
        outcome,
        ms: Date.now() - started,
        ...extra,
      });
    if (!HASH.test(hash)) {
      log("invalid");
      return context.json(
        {
          status: "error",
          data: {
            code: "INVALID_REQUEST",
            message: "Not an icon hash.",
            requestId,
          },
        },
        400,
      );
    }
    const cache = edgeCache();
    // One cache entry per hash: a query string never skips the cache.
    const url = new URL(context.req.url);
    const cacheKey = new Request(`${url.origin}${url.pathname}`);
    const cached = await cache?.match(cacheKey).catch(() => undefined);
    if (cached !== undefined) {
      log("edge-cache");
      // This request's id, not the one that filled the cache.
      const hit = new Response(cached.body, cached);
      hit.headers.set("X-Request-Id", requestId);
      return hit;
    }
    const db = context.env.DB;
    const icon = db === undefined ? undefined : await readPluginIcon(db, hash);
    if (icon === undefined) {
      log("not-found");
      context.header("Cache-Control", "no-store");
      return context.json(
        {
          status: "error",
          data: {
            code: "NOT_FOUND",
            message: "No plugin icon has that hash.",
            requestId,
          },
        },
        404,
      );
    }
    const response = new Response(icon.bytes as Uint8Array<ArrayBuffer>, {
      headers: iconHeaders(icon.mediaType, requestId),
    });
    if (cache !== undefined) {
      const put = cache.put(cacheKey, response.clone()).catch(() => undefined);
      try {
        context.executionCtx.waitUntil(put);
      } catch {
        // No request context (tests).
      }
    }
    log("d1", { bytes: icon.bytes.byteLength });
    return response;
  });
