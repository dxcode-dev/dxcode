import {
  clearBootReads,
  prefetchBootReads,
} from "../../shared/same-origin-fetch.js";

/**
 * Starts the first-load reads at boot, once the session check finds someone
 * signed in (#1379, #1599): `GET /v1/shell`, the account, the sidebar
 * layout, and on a Thread's page that Thread's reads. Each feature's query
 * takes its answer on its first read; see `prefetchBootReads`.
 */
export const startShellPrefetch = () => prefetchBootReads();

/** Signing out drops the parts read for the previous person. */
export const forgetShellPrefetch = () => clearBootReads();
