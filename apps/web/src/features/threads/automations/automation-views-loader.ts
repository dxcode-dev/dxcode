// The lists, cards, and sheet the Thread's automations open load in one chunk
// after first paint. A chip, the schedule hint, or the Thread menu's entries
// start it once the page is idle, or sooner at the first sign of reaching for
// one (a pointer over or down, or focus), so they open with their content in
// the first frame, as the Thread menu's details rows do.
export const loadAutomationViews = () => import("./automation-views.js");

export const preloadAutomationViews = () => void loadAutomationViews();

/** Loads the views once the browser is idle; returns its cancellation. */
export const preloadAutomationViewsWhenIdle = () => {
  if (typeof window.requestIdleCallback === "function") {
    const id = window.requestIdleCallback(preloadAutomationViews, {
      timeout: 4_000,
    });
    return () => window.cancelIdleCallback(id);
  }
  const timer = window.setTimeout(preloadAutomationViews, 1_500);
  return () => window.clearTimeout(timer);
};
