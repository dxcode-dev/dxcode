import { type ClaudePlanWindow, claudePlanWindowName } from "@dx/domain";
import { claudePlanWhen } from "./claude-plan-when.js";
import "./claude-plan-windows.css";

const level = (utilization: number) =>
  utilization >= 1 ? "full" : utilization >= 0.8 ? "high" : undefined;

const ClaudePlanWindowRow = ({
  window,
  now,
}: {
  readonly window: ClaudePlanWindow;
  readonly now: Date;
}) => {
  const name = claudePlanWindowName(window.id);
  // A window past its reset has started over; its last reading is stale.
  const reset = window.resetsAt * 1000 <= now.getTime();
  const percent = Math.round(window.utilization * 100);
  return (
    <li className="claude-plan-window">
      <span className="claude-plan-window-name">{name}</span>
      {/* The percent beside it carries the value for assistive tech. */}
      <span
        className="claude-plan-meter"
        aria-hidden="true"
        data-level={reset ? undefined : level(window.utilization)}
      >
        <span style={{ width: `${reset ? 0 : Math.min(percent, 100)}%` }} />
      </span>
      <span className="claude-plan-window-percent">
        {reset ? "–" : `${percent}%`}
      </span>
      <span className="claude-plan-window-reset">
        {reset ? "Reset" : "Resets"} {claudePlanWhen(window.resetsAt, now)}
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
