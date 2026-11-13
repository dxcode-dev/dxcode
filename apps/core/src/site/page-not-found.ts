import { isAppRoutePath } from "@dx/api";
import type { Context, NotFoundHandler } from "hono";
import type { AppEnv } from "../http/types.js";

/** Core's own paths: a miss there is an API error, not a page. */
const API_PATH = /^\/(?:api|v1)(?:\/|$)|^\/(?:healthz|readyz)$/;

const isDocsPath = (pathname: string) =>
  pathname === "/docs" || pathname.startsWith("/docs/");

/**
 * A static file read through the assets binding, under the given status.
 * The file keeps its own `_headers` policy; its validators describe the
 * file, not this answer, so they are dropped.
 */
const servedAs = (file: Response, status: number) => {
  const headers = new Headers(file.headers);
  headers.delete("etag");
  headers.delete("last-modified");
  return new Response(file.body, { status, headers });
};

/**
 * Cloudflare serves every path that names a file; every other path reaches
 * the Worker. A page path a person may reload or follow a link to gets the
 * app with 200. A docs path with no page gets the docs' 404 page, and any
 * other path the app with 404, which renders its own not-found screen.
 * Search engines then index only real pages.
 */
export const pageNotFound =
  (apiNotFound: NotFoundHandler<AppEnv>): NotFoundHandler<AppEnv> =>
  async (context: Context<AppEnv>) => {
    const assets = context.env?.ASSETS;
    const { method } = context.req;
    const url = new URL(context.req.url);
    if (
      assets === undefined ||
      (method !== "GET" && method !== "HEAD") ||
      API_PATH.test(url.pathname)
    )
      return apiNotFound(context);
    if (isDocsPath(url.pathname)) {
      // `/docs/404` is the docs' `404.html`; a package without the docs
      // site redirects every docs path before it reaches the Worker.
      const docsPage = await assets.fetch(new URL("/docs/404", url), {
        method,
      });
      if (docsPage.ok) return servedAs(docsPage, 404);
      await docsPage.body?.cancel();
    }
    const app = await assets.fetch(new URL("/", url), { method });
    if (!app.ok) return app;
    return servedAs(app, isAppRoutePath(url.pathname) ? 200 : 404);
  };
