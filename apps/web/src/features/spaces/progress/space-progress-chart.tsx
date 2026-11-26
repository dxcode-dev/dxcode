import type {
  SpaceProgressChange,
  SpaceProgressData,
  SpaceProgressDay,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import {
  GitCommitHorizontal,
  GitMerge,
  GitPullRequestArrow,
  X,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { useOpenSpaceThread } from "../use-open-space-thread.js";
import {
  spaceProgressQueryOptions,
  viewerTimeZone,
} from "./space-progress-queries.js";
import "./space-progress.css";

const COLUMN = 10;
const BAR = 6;
const HEIGHT = 100;
const TOP = 10;

const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

const dayLabel = (date: string) =>
  dayFormat.format(new Date(`${date}T00:00:00Z`));

const shippedOf = (day: SpaceProgressDay) => day.merged + day.pushed;

const plotOf = (days: ReadonlyArray<SpaceProgressDay>) => {
  const most = Math.max(
    1,
    ...days.map((day) => Math.max(day.openAtEnd, shippedOf(day))),
  );
  const y = (value: number) => HEIGHT - (value / most) * (HEIGHT - TOP);
  const center = (index: number) => index * COLUMN + COLUMN / 2;
  const points = days.map(
    ({ openAtEnd }, index) => [center(index), y(openAtEnd)] as const,
  );
  const line = points.map(([x, top]) => `${x},${top}`).join(" ");
  const last = points.at(-1);
  return {
    width: days.length * COLUMN,
    line,
    end:
      last === undefined
        ? undefined
        : {
            left: `${(last[0] / (days.length * COLUMN)) * 100}%`,
            top: `${(last[1] / HEIGHT) * 100}%`,
          },
    bars: days.flatMap((day, index) => {
      const shipped = shippedOf(day);
      return shipped === 0
        ? []
        : [
            {
              key: day.date,
              x: index * COLUMN + (COLUMN - BAR) / 2,
              y: y(shipped),
              height: HEIGHT - y(shipped),
            },
          ];
    }),
  };
};

const plural = (count: number, one: string, many: string) =>
  `${count} ${count === 1 ? one : many}`;

const summary = (day: SpaceProgressDay) =>
  `${dayLabel(day.date)}: ${plural(day.merged, "PR", "PRs")} merged, ${day.pushed} pushed to main, ${day.openAtEnd} open`;

function ChangeIcon({ change }: { readonly change: SpaceProgressChange }) {
  if (change.kind === "default_branch")
    return <GitCommitHorizontal aria-hidden="true" />;
  return change.state === "merged" ? (
    <GitMerge aria-hidden="true" />
  ) : (
    <GitPullRequestArrow aria-hidden="true" />
  );
}

function DayChanges({
  day,
  changes,
  onOpenThread,
  onClose,
}: {
  readonly day: SpaceProgressDay;
  readonly changes: ReadonlyMap<string, SpaceProgressChange>;
  readonly onOpenThread: (threadId: ThreadId) => void;
  readonly onClose: () => void;
}) {
  const listed = day.changeIds.flatMap((id) => changes.get(id) ?? []);
  return (
    <section className="space-progress-day" aria-label={dayLabel(day.date)}>
      <header>
        <span>{dayLabel(day.date)}</span>
        <Button
          variant="subtle"
          size="icon-xs"
          className="space-progress-day-close"
          aria-label="Close"
          onClick={onClose}
        >
          <X aria-hidden="true" />
        </Button>
      </header>
      {listed.length === 0 ? (
        <p>Nothing merged or pushed this day.</p>
      ) : (
        <ul>
          {listed.map((change) => (
            <li key={change.id}>
              <button
                type="button"
                className="space-shipped-change"
                data-state={change.state}
                onClick={() => onOpenThread(change.threadId)}
              >
                <ChangeIcon change={change} />
                <span className="space-progress-day-title">
                  {change.number === undefined ? null : (
                    <span className="space-shipped-number">
                      #{change.number}
                    </span>
                  )}
                  {change.title}
                </span>
                <small>{change.threadTitle}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * What a Space shipped over the last 30 days: per day, a bar of the pull
 * requests that merged plus direct pushes to main, and a line of the pull
 * requests still open. Each day is a button that lists its changes, and a
 * change opens the thread that made it.
 */
export function SpaceProgressChartView({
  progress,
  onOpenThread,
}: {
  /** Undefined while it loads. */
  readonly progress: SpaceProgressData | undefined;
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const [hovered, setHovered] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string | undefined>();
  const days = progress?.days ?? [];
  const plot = plotOf(days);
  const hoveredIndex = days.findIndex(({ date }) => date === hovered);
  const hoveredDay = days[hoveredIndex];
  const selectedDay = days.find(({ date }) => date === selected);
  const totals = progress?.totals ?? { merged: 0, pushed: 0, open: 0 };
  const changes = new Map(
    (progress?.changes ?? []).map((change) => [change.id, change]),
  );
  return (
    <div className="space-progress">
      <div className="space-progress-chart">
        <fieldset
          className="space-progress-plot"
          aria-label="Pull requests and pushes over the last 30 days"
          aria-busy={progress === undefined}
          onMouseLeave={() => setHovered(undefined)}
        >
          {days.length === 0 ? null : (
            <svg
              className="space-progress-svg"
              viewBox={`0 0 ${plot.width} ${HEIGHT}`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              {plot.bars.map((bar) => (
                <rect
                  key={bar.key}
                  className="space-progress-bar"
                  data-kind="shipped"
                  x={bar.x}
                  y={bar.y}
                  width={BAR}
                  height={bar.height}
                />
              ))}
              <polyline
                className="space-progress-line"
                points={plot.line}
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          )}
          {plot.end === undefined ? null : (
            <span
              className="space-progress-end"
              style={{ left: plot.end.left, top: plot.end.top }}
              aria-hidden="true"
            />
          )}
          <div
            className="space-progress-days"
            style={{ gridTemplateColumns: `repeat(${days.length || 1}, 1fr)` }}
          >
            {days.map((day) => (
              <button
                key={day.date}
                type="button"
                className="space-progress-day-button"
                aria-label={summary(day)}
                aria-pressed={selected === day.date}
                data-hovered={hovered === day.date ? "" : undefined}
                onMouseEnter={() => setHovered(day.date)}
                onFocus={() => setHovered(day.date)}
                onBlur={() => setHovered(undefined)}
                onClick={() =>
                  setSelected(selected === day.date ? undefined : day.date)
                }
              />
            ))}
          </div>
          {hoveredDay === undefined ? null : (
            <div
              className="space-progress-tooltip"
              role="tooltip"
              data-side={
                hoveredIndex < days.length / 3
                  ? "start"
                  : hoveredIndex > (days.length * 2) / 3
                    ? "end"
                    : "center"
              }
              style={{
                left: `${((hoveredIndex + 0.5) / days.length) * 100}%`,
              }}
            >
              {summary(hoveredDay)}
            </div>
          )}
        </fieldset>
        <ul className="space-progress-legend">
          <li data-kind="shipped">
            <span
              className="space-progress-swatch"
              data-kind="shipped"
              aria-hidden="true"
            />
            <strong>{totals.merged}</strong> merged
          </li>
          <li>
            <span
              className="space-progress-swatch"
              data-kind="shipped"
              aria-hidden="true"
            />
            <strong>{totals.pushed}</strong> pushed
          </li>
          <li>
            <span
              className="space-progress-swatch"
              data-kind="open"
              aria-hidden="true"
            />
            <strong>{totals.open}</strong> open
          </li>
        </ul>
      </div>
      {selectedDay === undefined ? null : (
        <DayChanges
          key={selectedDay.date}
          day={selectedDay}
          changes={changes}
          onOpenThread={onOpenThread}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}

/** The Space panel's chart, read in the viewer's time zone. */
export function SpaceProgressChart({
  spaceThreadId,
}: {
  readonly spaceThreadId: ThreadId;
}) {
  const { identity } = useAuthenticatedIdentity();
  const progress = useQuery(
    spaceProgressQueryOptions(identity.id, spaceThreadId, viewerTimeZone()),
  ).data;
  const openThread = useOpenSpaceThread();
  return (
    <SpaceProgressChartView
      progress={progress}
      onOpenThread={(threadId) => openThread(threadId)}
    />
  );
}
