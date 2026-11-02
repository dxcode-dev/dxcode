import { clearShellPrefetch, prefetchShell } from "../../shared/api/client.js";

/**
 * Starts the first-load reads at boot, beside the session check and the
 * signed-in app's code (#1379): `GET /v1/shell`, the account, and the
 * sidebar layout. Each feature's query takes its answer on its first read;
 * see `prefetchShell` in the dx transport.
 */
export const startShellPrefetch = () => prefetchShell();

/** Signing out drops the parts read for the previous person. */
export const forgetShellPrefetch = () => clearShellPrefetch();
