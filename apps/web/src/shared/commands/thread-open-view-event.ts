/**
 * The document event that asks the open Thread page to show one of its views,
 * with `{ view }` as its detail, and `threadId` when only that Thread's page
 * should. Its own module, so whatever opens a view does not load the command
 * provider with it.
 */
export const THREAD_OPEN_VIEW_EVENT = "dx-thread-open-view";

/** How long a Thread page that has not opened yet may still take a request. */
const REQUEST_LIFETIME_MS = 10_000;

let pending:
  | { readonly threadId: string; readonly view: string; readonly at: number }
  | undefined;

/**
 * Asks one Thread's page to show a view: the page open now, else the page
 * that opens next for that Thread, such as a Space's thread tab the same
 * click opens.
 */
export const requestThreadView = (threadId: string, view: string) => {
  pending = { threadId, view, at: Date.now() };
  document.dispatchEvent(
    new CustomEvent(THREAD_OPEN_VIEW_EVENT, { detail: { view, threadId } }),
  );
};

/** The view requested for this Thread's page in the last moments, once. */
export const takeThreadViewRequest = (threadId: string) => {
  const request = pending;
  if (request === undefined || request.threadId !== threadId) return undefined;
  pending = undefined;
  return Date.now() - request.at <= REQUEST_LIFETIME_MS
    ? request.view
    : undefined;
};
