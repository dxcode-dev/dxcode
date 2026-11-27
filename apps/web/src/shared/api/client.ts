import { ApiError, createDxClient, endpointPath } from "@dx/client";
import { noticeUnauthenticated } from "../auth/session-ended.js";
import { observeRequest } from "../diagnostics/client-diagnostics.js";
import { takeBootRead } from "../same-origin-fetch.js";

/**
 * `endpointPath` for a WebSocket URL or `src`, and `createDxClient` for a
 * feature with its own fetch. Feature code takes them from here, not from
 * `@dx/client`, so `@dx/client` stays in this module's chunk instead of a
 * chunk of its own on the Thread page's first load.
 */
export { ApiError, createDxClient, endpointPath };

/**
 * The web's dx client: same-origin cookies, the boot's prefetched reads, and
 * request diagnostics. Call endpoints from `@dx/api` with it instead of
 * writing a `/v1/` path here (wiki/headless-client.md).
 */
export const dxClient = createDxClient({
  takePrefetched: takeBootRead,
  fetch: async (path, init) => {
    const response = await observeRequest(path, init.method, () =>
      fetch(path, { ...init, credentials: "same-origin" }),
    );
    noticeUnauthenticated(response);
    return response;
  },
});
