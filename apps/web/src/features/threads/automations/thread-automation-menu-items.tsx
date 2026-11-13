import type { ThreadId } from "@dx/domain";
import {
  CalendarClock,
  CircleCheck,
  CircleDot,
  GitPullRequest,
} from "lucide-react";
import { MenuItem } from "../../../shared/ui/menu.js";
import {
  type AutomationView,
  automationViews,
  useThreadAutomations,
} from "./automations-queries.js";

/**
 * More Actions' entries for the Thread's issues, pull requests, CI, and
 * schedule and GitHub listeners, for a bar with no room for their chips.
 * Each opens its sheet through `onOpen`; `include` picks which are listed.
 */
export function ThreadAutomationMenuItems({
  threadId,
  include,
  onOpen,
}: {
  readonly threadId: ThreadId;
  readonly include?: (view: AutomationView) => boolean;
  readonly onOpen: (view: AutomationView) => void;
}) {
  const data = useThreadAutomations(threadId).data;
  return automationViews(data).map(({ view, label }) =>
    include === undefined || include(view) ? (
      <MenuItem key={view} onClick={() => onOpen(view)}>
        {view === "issues" ? (
          <CircleDot />
        ) : view === "pulls" ? (
          <GitPullRequest />
        ) : view === "ci" ? (
          <CircleCheck />
        ) : (
          <CalendarClock />
        )}
        <span>{label}</span>
      </MenuItem>
    ) : null,
  );
}
