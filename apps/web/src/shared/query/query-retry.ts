import { ApiError } from "../api/client.js";

/** Retry once after a network failure or 5xx; never after a cancel or a 4xx. */
export const retryQuery = (failureCount: number, error: unknown) => {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
};

/**
 * Whether mounting a query that already failed reads it again: not after a
 * 4xx, which the server will answer the same way (a hidden or missing
 * Thread), so a page that prefetched the read on boot shows the answer it
 * has; yes after a network failure or a 5xx, which may pass.
 */
export const retryOnMountQuery = (query: {
  readonly state: { readonly error: unknown };
}) =>
  !(query.state.error instanceof ApiError && query.state.error.status < 500);
