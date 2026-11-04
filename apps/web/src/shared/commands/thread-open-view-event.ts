/**
 * The document event that asks the open Thread page to show one of its views,
 * with `{ view }` as its detail. Its own module, so whatever opens a view
 * does not load the command provider with it.
 */
export const THREAD_OPEN_VIEW_EVENT = "dx-thread-open-view";
