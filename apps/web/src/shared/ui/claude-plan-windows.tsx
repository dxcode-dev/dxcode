import {
  type ClaudePlanWindow,
  claudePlanCurrentWindow,
  claudePlanWindowName,
} from "@dx/domain";
import { claudePlanWhen } from "./claude-plan-when.js";
import { Meter } from "./meter.js";
import "./claude-plan-windows.css";

const tone = (utilization: number) =>
  utilization >= 1 ? "danger" : utilization >= 0.8 ? "warning" : "default";

const ClaudePlanWindowRow = ({
  window,
  now,
}: {
  readonly window: ClaudePlanWindow;
  readonly now: Date;
}) => {
  const name = claudePlanWindowName(window.id);
  // A window past its reset has started over; its last reading is stale. A
  // weekly one shows its next reset, a week after the last.
  const reset = window.resetsAt * 1000 <= now.getTime();
  const next = reset
    ? claudePlanCurrentWindow(window, Math.floor(now.getTime() / 1000))
    : undefined;
  const percent = Math.round(window.utilization * 100);
  return (
    <li className="claude-plan-window">
      <span className="claude-plan-window-name">{name}</span>
      {/* The percent beside it carries the value for assistive tech. */}
      <Meter
        decorative
        size="md"
        value={reset ? 0 : Math.min(percent, 100)}
        max={100}
        tone={reset ? "default" : tone(window.utilization)}
      />
      <span className="claude-plan-window-percent">
        {reset ? "–" : `${percent}%`}
      </span>
      <span className="claude-plan-window-reset">
        {next !== undefined
          ? `Resets ${claudePlanWhen(next.resetsAt, now)}`
          : `${reset ? "Reset" : "Resets"} ${claudePlanWhen(window.resetsAt, now)}`}
      </span>
    </li>
  );
};

/**
 * A Claude plan's limit windows as Claude Code last reported them: each
 * window's meter, how much of it is used, and when it resets.
 */
export const ClaudePlanWindows = ({
  windows,
  now,
}: {
  readonly windows: ReadonlyArray<ClaudePlanWindow>;
  readonly now: Date;
}) => (
  <ul className="claude-plan-windows">
    {windows.map((window) => (
      <ClaudePlanWindowRow key={window.id} window={window} now={now} />
    ))}
  </ul>
);
