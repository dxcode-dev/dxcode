import * as React from "react";

// Browsers' messages for a dynamic import whose module could not be loaded.
// After a deploy, a tab opened earlier asks for chunk hashes that no longer
// exist; the asset fallback answers with index.html, which fails this way.
// TanStack's `lazyRouteComponent` recognizes the same messages and reloads
// the page once to pick up the new build.
const staleChunkMessages = [
  "Failed to fetch dynamically imported module",
  "error loading dynamically imported module",
  "Importing a module script failed",
];

export const isStaleChunkError = (error: unknown): error is Error =>
  error instanceof Error &&
  staleChunkMessages.some((prefix) => error.message.startsWith(prefix));

const RELOAD_KEY_PREFIX = "dx:stale-chunk-reload:";
/**
 * A chunk that fails again this soon after its reload is missing from the new
 * build too, so it shows its error instead of reloading in a loop.
 */
const RELOAD_RETRY_MS = 30_000;

/**
 * Reloads the page when `error` is a chunk a deploy removed, unless the same
 * failure already reloaded it moments ago. Returns whether it reloaded.
 */
const reloadForStaleChunk = (error: unknown) => {
  if (!isStaleChunkError(error)) return false;
  const key = `${RELOAD_KEY_PREFIX}${error.message}`;
  try {
    const last = Number(sessionStorage.getItem(key) ?? 0);
    if (Date.now() - last < RELOAD_RETRY_MS) return false;
    sessionStorage.setItem(key, String(Date.now()));
  } catch {
    // Without storage there is no loop guard: show the error.
    return false;
  }
  window.location.reload();
  return true;
};

/**
 * `React.lazy` for a component in its own chunk. A tab opened before a deploy
 * reloads to the new build when the chunk is gone, and stays suspended until
 * the reload replaces it, instead of the error view replacing the page.
 */
// biome-ignore lint/suspicious/noExplicitAny: React.lazy's own constraint
export const lazyComponent = <T extends React.ComponentType<any>>(
  load: () => Promise<{ default: T }>,
) =>
  React.lazy(() =>
    load().catch((error: unknown) => {
      if (reloadForStaleChunk(error)) return new Promise<never>(() => {});
      throw error;
    }),
  );
