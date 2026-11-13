import type {
  SpaceProgressDay,
  SpaceProgressOutcome,
  SpaceProgressThread,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { useOpenSpaceThread } from "../use-open-space-thread.js";
import {
  spaceProgressQueryOptions,
  viewerTimeZone,
} from "./space-progress-queries.js";
import "./space-progress.css";

/** One day's column in the SVG's own units; the SVG stretches to fit. */
const COLUMN = 10;
const BAR = 6;
const HEIGHT = 100;
/** Room above the highest value for the line's end dot. */
const TOP = 10;
/** The surface gap between a day's shipped and archived segments. */
const GAP = 3;

const dayFormat = new Intl.DateTimeFormat("en-US", {
  weekday: "short",
  month: "short",
  day: "numeric",
  timeZone: "UTC",
});

/** "Fri, Oct 9" for `YYYY-MM-DD`. */
const dayLabel = (date: string) =>
  dayFormat.format(new Date(`${date}T00:00:00Z`));

const OUTCOME_LABEL: Record<SpaceProgressOutcome, string> = {
  shipped: "Shipped",
  archived: "Archived",
  open: "Open",
};

/** Geometry for the bars, the open line, and its end dot. */
const plotOf = (days: ReadonlyArray<SpaceProgressDay>) => {
  const most = Math.max(
    1,
    ...days.map(({ openAtEnd, shipped, archived }) =>
      Math.max(openAtEnd, shipped + archived),
    ),
  );
  const y = (value: number) => HEIGHT - (value / most) * (HEIGHT - TOP);
  const height = (value: number) => (value / most) * (HEIGHT - TOP);
  const center = (index: number) => index * COLUMN + COLUMN / 2;
  const points = days.map(
    ({ openAtEnd }, index) => [center(index), y(openAtEnd)] as const,
  );
  const line = points.map(([x, top]) => `${x},${top}`).join(" ");
  const first = points[0];
  const last = points.at(-1);
  return {
    width: days.length * COLUMN,
    line,
    area:
      first === undefined || last === undefined
        ? ""
        : `${first[0]},${HEIGHT} ${line} ${last[0]},${HEIGHT}`,
    end:
      last === undefined
        ? undefined
        : {
            left: `${(last[0] / (days.length * COLUMN)) * 100}%`,
            top: `${(last[1] / HEIGHT) * 100}%`,
          },
    bars: days.flatMap(({ date, shipped, archived }, index) => {
      const x = index * COLUMN + (COLUMN - BAR) / 2;
      const shippedHeight = height(shipped);
      const archivedHeight = height(archived);
      return [
        ...(shipped > 0
          ? [
              {
                key: `${date}-shipped`,
                kind: "shipped",
                x,
                y: HEIGHT - shippedHeight,
                height: shippedHeight,
              },
            ]
          : []),
        ...(archived > 0
          ? [
              {
                key: `${date}-archived`,
                kind: "archived",
                x,
                // Above the shipped segment, a surface gap between them.
                y: HEIGHT - shippedHeight - archivedHeight,
                height: Math.max(0, archivedHeight - (shipped > 0 ? GAP : 0)),
              },
            ]
          : []),
      ];
    }),
  };
};

const summary = (day: SpaceProgressDay) =>
  `${dayLabel(day.date)}: ${day.created} created, ${day.shipped} shipped, ${day.archived} archived`;

function DayThreads({
  day,
  threads,
  onClose,
}: {
  readonly day: SpaceProgressDay;
  readonly threads: ReadonlyMap<ThreadId, SpaceProgressThread>;
  readonly onClose: () => void;
}) {
  const openThread = useOpenSpaceThread();
  const listed = day.threadIds.flatMap((id) => threads.get(id) ?? []);
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
        <p>No threads started, shipped, or archived this day.</p>
      ) : (
        <ul>
          {listed.map((thread) => (
            <li key={thread.id}>
              <button type="button" onClick={() => openThread(thread.id)}>
                <span
                  className="space-progress-outcome"
                  data-outcome={thread.outcome}
                  aria-hidden="true"
                />
                <span className="space-progress-day-title">{thread.title}</span>
                <small>{OUTCOME_LABEL[thread.outcome]}</small>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * The threads a Space started over the last 30 days: per day, bars of how
 * many shipped (green) and were archived without shipping (gray), and a
 * line of how many were open when the day ended. Each day is a button that
 * lists its threads.
 */
export function SpaceProgressChart({
  spaceThreadId,
}: {
  readonly spaceThreadId: ThreadId;
}) {
  const { identity } = useAuthenticatedIdentity();
  const progress = useQuery(
    spaceProgressQueryOptions(identity.id, spaceThreadId, viewerTimeZone()),
  ).data;
  const [hovered, setHovered] = React.useState<string | undefined>();
  const [selected, setSelected] = React.useState<string | undefined>();
  const days = progress?.days ?? [];
  const plot = plotOf(days);
  const hoveredIndex = days.findIndex(({ date }) => date === hovered);
  const hoveredDay = days[hoveredIndex];
  const selectedDay = days.find(({ date }) => date === selected);
  const totals = progress?.totals ?? { shipped: 0, archived: 0, open: 0 };
  const threads = new Map(
    (progress?.threads ?? []).map((thread) => [thread.id, thread]),
  );
  return (
    <div className="space-progress">
      <div className="space-progress-chart">
        <fieldset
          className="space-progress-plot"
          aria-label="Threads over the last 30 days"
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
              <polygon className="space-progress-area" points={plot.area} />
              {plot.bars.map((bar) => (
                <rect
                  key={bar.key}
                  className="space-progress-bar"
                  data-kind={bar.kind}
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
              {`${summary(hoveredDay)}, ${hoveredDay.openAtEnd} open`}
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
            <strong>{totals.shipped}</strong> shipped
          </li>
          <li>
            <span
              className="space-progress-swatch"
              data-kind="archived"
              aria-hidden="true"
            />
            <strong>{totals.archived}</strong> archived
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
        <DayThreads
          key={selectedDay.date}
          day={selectedDay}
          threads={threads}
          onClose={() => setSelected(undefined)}
        />
      )}
    </div>
  );
}
