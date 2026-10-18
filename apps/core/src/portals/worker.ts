// The Portal Worker: the whole of the Worker deployed on the wildcard route
// `*.<portal-domain>/*`. Core's own Worker serves the app's static assets
// before any code runs, which would answer Portal paths with the dx app, so
// Portals get a Worker without assets that shares Core's D1 database,
// Thread execution objects, and auth secret. Local development and tests
// reach the same handler through Core (see host-routing.ts).

import { handlePortalRequest, type PortalWorkerBindings } from "./handler.js";
import { matchPortalHost, portalConfiguration } from "./host.js";

export default {
  fetch(request: Request, env: PortalWorkerBindings) {
    const configuration = portalConfiguration(env);
    const match =
      configuration === undefined
        ? undefined
        : matchPortalHost(new URL(request.url), configuration);
    if (configuration === undefined || match === undefined)
      return new Response("Not found", { status: 404 });
    return handlePortalRequest(request, env, configuration, match);
  },
} satisfies ExportedHandler<PortalWorkerBindings>;
