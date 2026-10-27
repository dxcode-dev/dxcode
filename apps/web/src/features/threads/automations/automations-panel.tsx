import type { ThreadAutomationsData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { hasThreadAutomations } from "./automations-queries.js";
import { ScheduleCard } from "./schedule-card.js";
import { SubscriptionRow } from "./subscription-row.js";
import "./automations.css";

/** Everything the Thread runs on its own: its schedule, then its listeners. */
export function AutomationsPanel({
  threadId,
  data,
  scheduleOnly = false,
}: {
  readonly threadId: ThreadId;
  readonly data: ThreadAutomationsData;
  readonly scheduleOnly?: boolean;
}) {
  const subscriptions = scheduleOnly ? [] : data.githubSubscriptions;
  return (
    <div className="automation-panel">
      {data.schedule === undefined ? null : (
        <ScheduleCard threadId={threadId} schedule={data.schedule} />
      )}
      {subscriptions.length === 0 ? null : (
        <ul className="automation-subscriptions" aria-label="GitHub events">
          {subscriptions.map((subscription) => (
            <SubscriptionRow
              key={subscription.id}
              threadId={threadId}
              subscription={subscription}
            />
          ))}
        </ul>
      )}
      {hasThreadAutomations(data) ? null : (
        <p className="automation-empty">No schedule or GitHub events.</p>
      )}
    </div>
  );
}
