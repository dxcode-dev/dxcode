import type { ThreadId } from "@dx/domain";
import { Clock } from "lucide-react";
import * as React from "react";
import { TimeText } from "../../../shared/ui/time-text.js";
import { useMobile } from "../../../shared/use-mobile.js";
import { runText } from "./automation-text.js";
import { AutomationsPanel } from "./automations-panel.js";
import { AutomationsPopover } from "./automations-popover.js";
import { useThreadAutomations } from "./automations-queries.js";
import { ThreadAutomationsSheet } from "./thread-automations-sheet.js";

/**
 * At the transcript's end while no run is active: when the schedule runs
 * next. It opens the same schedule card as the header.
 */
export function ThreadScheduleHint({
  threadId,
}: {
  readonly threadId: ThreadId;
}) {
  const automations = useThreadAutomations(threadId);
  const mobile = useMobile();
  const [sheetOpen, setSheetOpen] = React.useState(false);
  const schedule = automations.data?.schedule;
  if (automations.data === undefined || schedule === undefined) return null;
  const hint = (
    <>
      <Clock aria-hidden="true" />
      <TimeText text={(now) => runText(schedule, now)} />
    </>
  );
  if (mobile)
    return (
      <div className="automation-hint-row">
        <button
          type="button"
          className="automation-hint"
          aria-label={`Schedule: ${schedule.title}`}
          onClick={() => setSheetOpen(true)}
        >
          {hint}
        </button>
        {sheetOpen ? (
          <ThreadAutomationsSheet
            view="listeners"
            threadId={threadId}
            onClose={() => setSheetOpen(false)}
          />
        ) : null}
      </div>
    );
  return (
    <div className="automation-hint-row">
      <AutomationsPopover
        triggerClassName="automation-hint"
        triggerLabel={`Schedule: ${schedule.title}`}
        trigger={hint}
        above
      >
        <AutomationsPanel
          threadId={threadId}
          data={automations.data}
          scheduleOnly
        />
      </AutomationsPopover>
    </div>
  );
}
