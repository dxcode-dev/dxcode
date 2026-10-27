import { parseGitHubDelivery } from "@dx/api";
import * as React from "react";
import { GitHubEventRow } from "./github-event-row.js";
import "./automations.css";

/**
 * What a GitHub subscription delivered, one row per event: a linked line
 * such as "PR #12 merged", or for CI "Finished running CI" opening to the
 * commit and each check. Text someone wrote on GitHub opens under its line.
 * A message that is not a delivery shows as it was sent.
 */
export function GitHubEventRows({
  text,
  pending,
}: {
  readonly text: string;
  readonly pending: boolean;
}) {
  const events = parseGitHubDelivery(text);
  const [open, setOpen] = React.useState<ReadonlySet<number>>(
    () =>
      new Set(
        events.flatMap((event, index) => (event.kind === "ci" ? [index] : [])),
      ),
  );
  const toggle = (index: number) =>
    setOpen((current) => {
      const next = new Set(current);
      if (next.has(index)) next.delete(index);
      else next.add(index);
      return next;
    });
  if (events.length === 0)
    return <p className="github-event-fallback">{text}</p>;
  return (
    <div className="github-events" data-pending={pending || undefined}>
      {events.map((event, index) => (
        <GitHubEventRow
          key={`${event.kind} ${event.url} ${event.label}`}
          event={event}
          open={open.has(index)}
          onToggle={() => toggle(index)}
        />
      ))}
    </div>
  );
}
