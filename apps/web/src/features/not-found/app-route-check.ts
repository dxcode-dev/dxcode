/**
 * Whether a URL is a dx page. The signed-out router imports it on demand,
 * when a visitor lands on a URL no public route matches, so the page list
 * stays out of every first load.
 */
export { isAppRoutePath } from "@dx/api";
