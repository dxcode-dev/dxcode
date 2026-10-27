import { Dialog } from "@base-ui/react/dialog";
import type { ThreadId } from "@dx/domain";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "../../../shared/ui/modal-surface.js";
import {
  type AutomationView,
  automationViews,
  useThreadAutomations,
} from "./automations-queries.js";
import { AutomationViewContent } from "./thread-automations-button.js";

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
    <Dialog.Root open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface className="automation-sheet" ariaLabel={label}>
        <ModalSurfaceHeader>
          <strong>{label}</strong>
          <ModalSurfaceClose />
        </ModalSurfaceHeader>
        {data === undefined ? null : (
          <AutomationViewContent threadId={threadId} data={data} view={view} />
        )}
      </ModalSurface>
    </Dialog.Root>
  );
}
