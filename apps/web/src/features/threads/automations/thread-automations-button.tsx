import type { ThreadAutomationsData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Radio } from "lucide-react";
import type * as React from "react";
import { TitleBarItemSlot } from "../title-bar-item.js";
import type { TitleBarItem, TitleBarItemRef } from "../title-bar-overflow.js";
import { AutomationsPanel } from "./automations-panel.js";
import { AutomationsPopover } from "./automations-popover.js";
import {
  type AutomationView,
  hasThreadAutomations,
  useThreadAutomations,
} from "./automations-queries.js";
import { CiRunList, PullRequestList } from "./github-header-lists.js";
import { ciIcon, ciWords, pullIcon } from "./github-status.js";

/** The open PR wins the icon; else merged when all merged, else closed. */
const pullState = (pulls: ThreadAutomationsData["pullRequests"]) =>
  pulls.some(({ state }) => state === "open")
    ? ("open" as const)
    : pulls.every(({ state }) => state === "merged")
      ? ("merged" as const)
      : ("closed" as const);

/** Active listeners plus the schedule, for the listeners entry. */
const listening = (data: ThreadAutomationsData) => {
  const active = data.githubSubscriptions.filter(
    ({ state, enabled }) => state === "active" && enabled,
  ).length;
  return {
    count: active + (data.schedule === undefined ? 0 : 1),
    label:
      [
        active === 0
          ? undefined
          : `${active} event ${active === 1 ? "subscription" : "subscriptions"}`,
        data.schedule === undefined ? undefined : "Scheduled",
      ]
        .filter((part) => part !== undefined)
        .join(" · ") || "Schedule and GitHub events",
  };
};

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
  return view === "pulls" ? (
    <PullRequestList pulls={data.pullRequests} />
  ) : view === "ci" ? (
    <CiRunList runs={data.ciRuns} />
  ) : (
    <AutomationsPanel threadId={threadId} data={data} />
  );
}

/**
 * The header's entries: the pull requests the Thread opened, CI on its
 * commits, and its schedule and GitHub listeners. Each shows only when it
 * has something. In a compact bar each sits in a slot the bar can take out
 * of the row when it runs out of room.
 */
export function ThreadAutomationsButton({
  threadId,
  itemRef,
  hidden,
}: {
  readonly threadId: ThreadId;
  readonly itemRef?: TitleBarItemRef;
  readonly hidden?: ReadonlySet<TitleBarItem>;
}) {
  const data = useThreadAutomations(threadId).data;
  if (data === undefined) return null;
  const pulls = data.pullRequests;
  const latestCi = data.ciRuns[0];
  const listeners = listening(data);
  const chip = "thread-header-chip thread-header-chip-button automation-chip";
  const slot = (id: TitleBarItem, child: React.ReactNode) => (
    <TitleBarItemSlot id={id} itemRef={itemRef} hidden={hidden}>
      {child}
    </TitleBarItemSlot>
  );
  return (
    <>
      {pulls.length === 0
        ? null
        : slot(
            "pulls",
            <AutomationsPopover
              triggerClassName={chip}
              triggerLabel={`${pulls.length} GitHub pull ${pulls.length === 1 ? "request" : "requests"} (${pullState(pulls)})`}
              trigger={
                <>
                  {pullIcon(pullState(pulls))}
                  <span className="thread-header-chip-label">
                    {pulls.length}
                  </span>
                </>
              }
            >
              <PullRequestList pulls={pulls} />
            </AutomationsPopover>,
          )}
      {latestCi === undefined
        ? null
        : slot(
            "ci",
            <AutomationsPopover
              triggerClassName={chip}
              triggerLabel={`${ciWords(latestCi)} on ${latestCi.sha.slice(0, 7)}`}
              trigger={
                <>
                  {ciIcon(latestCi.result)}
                  <span className="thread-header-chip-label">
                    {data.ciRuns.length}
                  </span>
                </>
              }
            >
              <CiRunList runs={data.ciRuns} />
            </AutomationsPopover>,
          )}
      {!hasThreadAutomations(data)
        ? null
        : slot(
            "listeners",
            <AutomationsPopover
              triggerClassName={chip}
              triggerLabel={listeners.label}
              trigger={
                <>
                  <Radio aria-hidden="true" />
                  {listeners.count === 0 ? null : (
                    <span className="thread-header-chip-label">
                      {listeners.count}
                    </span>
                  )}
                </>
              }
            >
              <AutomationsPanel threadId={threadId} data={data} />
            </AutomationsPopover>,
          )}
    </>
  );
}
