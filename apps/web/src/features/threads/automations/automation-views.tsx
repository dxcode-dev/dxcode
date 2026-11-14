import type { ThreadAutomationsData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { DialogRoot } from "../../../shared/ui/dialog.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../../shared/ui/modal-surface.js";
import { AutomationsPanel } from "./automations-panel.js";
import {
  type AutomationView,
  automationViews,
  useThreadAutomations,
} from "./automations-queries.js";
import {
  CiRunList,
  IssueList,
  PullRequestList,
} from "./github-header-lists.js";

// What the title bar's automation chips, the schedule hint, and a phone's
// sheets open. `lazy-automation-views.tsx` loads this module, so none of it
// ships on the Thread page's first load.

export { AutomationsPanel };

/** What one entry opens: the PR list, the CI list, or the listeners. */
export function AutomationViewContent({
  threadId,
  data,
  view,
}: {
  readonly threadId: ThreadId;
  readonly data: ThreadAutomationsData;
  readonly view: AutomationView;
}) {
  return view === "issues" ? (
    <IssueList issues={data.issues} />
  ) : view === "pulls" ? (
    <PullRequestList pulls={data.pullRequests} />
  ) : view === "ci" ? (
    <CiRunList runs={data.ciRuns} />
  ) : (
    <AutomationsPanel threadId={threadId} data={data} />
  );
}

/**
 * On a phone each header entry opens as a sheet, from the Thread menu or,
 * for the listeners, the transcript's schedule hint.
 */
export function ThreadAutomationsSheet({
  threadId,
  view,
  onClose,
}: {
  readonly threadId: ThreadId;
  readonly view: AutomationView;
  readonly onClose: () => void;
}) {
  const data = useThreadAutomations(threadId).data;
  const label =
    automationViews(data).find((entry) => entry.view === view)?.label ??
    "Schedule and GitHub events";
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface className="automation-sheet" ariaLabel={label}>
        <ModalSurfaceHeader>
          <strong>{label}</strong>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        {data === undefined ? null : (
          <AutomationViewContent threadId={threadId} data={data} view={view} />
        )}
      </ModalSurface>
    </DialogRoot>
  );
}
