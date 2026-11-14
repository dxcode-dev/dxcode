import { Hono } from "hono";
import type { AppEnv } from "../../http/types.js";

/**
 * The plugin stream routes, registered at startup but loaded on their first request, so
 * the stream code adds nothing to the Worker's startup.
 */
const routes = () => import("./routes.js");

export const pluginStreamViewerRoutes = new Hono<AppEnv>()
  .get("/:threadId/plugin-ui/panes/:plugin/:pane/stream", async (context) =>
    (await routes()).viewerStream(context),
  )
  .get(
    "/:threadId/plugin-ui/panes/:plugin/:pane/ice-servers",
    async (context) => (await routes()).paneIceServersRoute(context),
  );

export const pluginStreamProducerRoutes = new Hono<AppEnv>().get(
  "/producer",
  async (context) => (await routes()).producerStream(context),
);
