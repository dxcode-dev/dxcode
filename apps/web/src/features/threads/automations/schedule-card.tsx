import type { ThreadScheduleData } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { Check, Clock, Copy, Trash2 } from "lucide-react";
import * as React from "react";
import { SettingsToggle } from "../../../shared/ui/settings.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { errorText, runText } from "./automation-text.js";
import { useAutomationAction } from "./automations-queries.js";

/** The schedule: pause or resume, delete, and its prompt to read or copy. */
export function ScheduleCard({
  threadId,
  schedule,
}: {
  readonly threadId: ThreadId;
  readonly schedule: ThreadScheduleData;
}) {
  const action = useAutomationAction(threadId);
  const [expanded, setExpanded] = React.useState(false);
  const [copied, setCopied] = React.useState(false);
  const canToggle = schedule.nextRunAt !== undefined;
  const copy = () =>
    void navigator.clipboard.writeText(schedule.prompt).then(
      () => setCopied(true),
      () => setCopied(false),
    );
  return (
    <section className="automation-schedule" aria-label="Schedule">
      <header className="automation-schedule-header">
        <strong>{schedule.title}</strong>
        <SettingsToggle
          checked={schedule.enabled && canToggle}
          disabled={!canToggle}
          pending={action.isPending}
          label={schedule.enabled ? "Pause automation" : "Resume automation"}
          onCheckedChange={(enabled) =>
            action.mutate({ kind: "schedule", enabled })
          }
        />
        <button
          type="button"
          className="automation-icon-button"
          aria-label="Delete schedule"
          title="Delete schedule"
          disabled={action.isPending}
          onClick={() => action.mutate({ kind: "schedule" })}
        >
          <Trash2 aria-hidden="true" />
        </button>
      </header>
      <p className="automation-schedule-meta">
        <Clock aria-hidden="true" />
        <span>
          {schedule.label} · <TimeText text={(now) => runText(schedule, now)} />
        </span>
      </p>
      <div className="automation-prompt" data-expanded={expanded || undefined}>
        <button
          type="button"
          className="automation-prompt-text"
          aria-expanded={expanded}
          aria-label={expanded ? "Collapse prompt" : "Expand prompt"}
          onClick={() => setExpanded(!expanded)}
        >
          <span className="automation-prompt-lines">{schedule.prompt}</span>
        </button>
        <button
          type="button"
          className="automation-icon-button automation-prompt-copy"
          aria-label={copied ? "Prompt copied" : "Copy prompt"}
          title={copied ? "Copied" : "Copy prompt"}
          onClick={copy}
          onBlur={() => setCopied(false)}
        >
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </button>
      </div>
      {action.error === null ? null : (
        <p className="automation-error" role="alert">
          {errorText(action.error)}
        </p>
      )}
    </section>
  );
}
