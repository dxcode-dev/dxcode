import type { ThreadAutomationsData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Radio } from "lucide-react";
import type * as React from "react";
import {
  ciIcon,
  ciWords,
  issueIcon,
  pullIcon,
} from "../../../shared/ui/github-status.js";
import { TitleBarItemSlot } from "../title-bar-item.js";
import type { TitleBarItem, TitleBarItemRef } from "../title-bar-overflow.js";
import { AutomationsPopover } from "./automations-popover.js";
import {
  hasThreadAutomations,
  useThreadAutomations,
} from "./automations-queries.js";
import { AutomationViewContent } from "./lazy-automation-views.js";
import "./automations.css";

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

/**
 * The header's entries: the issues the Thread works on, the pull requests
 * it opened, CI on its
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
  const issues = data.issues;
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
      {issues.length === 0
        ? null
        : slot(
            "issues",
            <AutomationsPopover
              triggerClassName={chip}
              triggerLabel={
                issues.length === 1
                  ? `GitHub issue #${issues[0]?.number} (${issues[0]?.state})`
                  : `${issues.length} GitHub issues (${issues.filter(({ state }) => state === "open").length} open)`
              }
              trigger={
                <>
                  {issueIcon(
                    issues.some(({ state }) => state === "open")
                      ? "open"
                      : "closed",
                  )}
                  <span className="thread-header-chip-label">
                    {issues.length === 1
                      ? `#${issues[0]?.number}`
                      : issues.length}
                  </span>
                </>
              }
            >
              <AutomationViewContent
                threadId={threadId}
                data={data}
                view="issues"
              />
            </AutomationsPopover>,
          )}
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
              <AutomationViewContent
                threadId={threadId}
                data={data}
                view="pulls"
              />
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
              <AutomationViewContent
                threadId={threadId}
                data={data}
                view="ci"
              />
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
              <AutomationViewContent
                threadId={threadId}
                data={data}
                view="listeners"
              />
            </AutomationsPopover>,
          )}
    </>
  );
}
