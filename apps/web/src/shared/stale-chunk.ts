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

export const isStaleChunkError = (error: unknown) =>
  error instanceof Error &&
  staleChunkMessages.some((prefix) => error.message.startsWith(prefix));
