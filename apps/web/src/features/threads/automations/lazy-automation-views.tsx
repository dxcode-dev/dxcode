import type { ThreadAutomationsData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import * as React from "react";
import { loadAutomationViews } from "./automation-views-loader.js";
import type { AutomationView } from "./automations-queries.js";

// Each wraps its lazy view in its own Suspense, so a caller (the Space page
// included) renders it like any component; see `automation-views-loader.ts`.

const LazyContent = React.lazy(() =>
  loadAutomationViews().then((module) => ({
    default: module.AutomationViewContent,
  })),
);
const LazyPanel = React.lazy(() =>
  loadAutomationViews().then((module) => ({
    default: module.AutomationsPanel,
  })),
);
const LazySheet = React.lazy(() =>
  loadAutomationViews().then((module) => ({
    default: module.ThreadAutomationsSheet,
  })),
);

/** What one entry opens: the issue, PR, or CI list, or the listeners. */
export function AutomationViewContent(props: {
  readonly threadId: ThreadId;
  readonly data: ThreadAutomationsData;
  readonly view: AutomationView;
}) {
  return (
    <React.Suspense fallback={null}>
      <LazyContent {...props} />
    </React.Suspense>
  );
}

/** The schedule card and GitHub listeners. */
export function AutomationsPanel(props: {
  readonly threadId: ThreadId;
  readonly data: ThreadAutomationsData;
  readonly scheduleOnly?: boolean;
}) {
  return (
    <React.Suspense fallback={null}>
      <LazyPanel {...props} />
    </React.Suspense>
  );
}

/**
 * On a phone each header entry opens as a sheet, from the Thread menu or,
 * for the listeners, the transcript's schedule hint.
 */
export function ThreadAutomationsSheet(props: {
  readonly threadId: ThreadId;
  readonly view: AutomationView;
  readonly onClose: () => void;
}) {
  return (
    <React.Suspense fallback={null}>
      <LazySheet {...props} />
    </React.Suspense>
  );
}
