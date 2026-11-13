import { DateTime } from "effect";
import type * as React from "react";
import { SegmentedControl } from "../../../shared/ui/segmented-control.js";
import { SettingsCard } from "../settings-primitives.js";
import { USAGE_LOCALE } from "./usage-format.js";
import {
  amountLabel,
  formatCount,
  totalLabel,
  USAGE_RANGES,
  type UsageAmount,
  type UsageBreakdownRow,
  type UsageMeasure,
  type UsageRange,
  usageDay,
  usageTime,
} from "./usage-values.js";

/**
 * The parts personal and workspace Usage share, so both pages read alike:
 * the Tokens/Cost and range toolbar, the Thread dot strip, the totals card
 * with its breakdowns, and the Threads table.
 */

export function UsageToolbar({
  mode,
  onModeChange,
  days,
  onDaysChange,
  children,
}: {
  readonly mode: UsageMeasure;
  readonly onModeChange: (mode: UsageMeasure) => void;
  readonly days: UsageRange;
  readonly onDaysChange: (days: UsageRange) => void;
  readonly children?: React.ReactNode;
}) {
  return (
    <div className="usage-toolbar">
      {children}
      <SegmentedControl
        label="Measure"
        value={mode}
        onValueChange={onModeChange}
        options={[
          ["tokens", "Tokens"],
          ["cost", "Cost"],
        ]}
      />
      <UsageRangeTabs days={days} onDaysChange={onDaysChange} />
    </div>
  );
}

/** The 7d–90d pills every usage page shares. */
export function UsageRangeTabs({
  days,
  onDaysChange,
}: {
  readonly days: UsageRange;
  readonly onDaysChange: (days: UsageRange) => void;
}) {
  return (
    <SegmentedControl
      label="Range"
      value={String(days)}
      onValueChange={(value) => onDaysChange(Number(value) as UsageRange)}
      options={USAGE_RANGES.map((item) => [String(item), `${item}d`] as const)}
    />
  );
}

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const DAY = 86_400_000;
const HOUR = 3_600_000;

/** A Thread on the activity strip: its model use by hour, or one point. */
export interface UsageDotThread extends UsageAmount {
  readonly threadId: string;
  readonly title: string;
  readonly createdAt: DateTime.Utc;
  readonly activity?: ReadonlyArray<{
    readonly hour: DateTime.Utc;
    readonly totalTokens: number;
    readonly estimatedCostMicros: number;
  }>;
}

const threadHref = (threadId: string) =>
  `/threads/${encodeURIComponent(threadId)}`;

/** Rows of the strip are this far apart, in pixels. */
const LANE_PX = 18;
/** Two Threads share a row when this much of the range separates them. */
const LANE_GAP = 0.012;

interface Track {
  readonly thread: UsageDotThread;
  /** Start and end as fractions of the range. */
  readonly start: number;
  readonly end: number;
  readonly points: ReadonlyArray<{
    readonly at: number;
    readonly value: number;
  }>;
  readonly lane: number;
}

/**
 * Each Thread as a line from its first to its last hour of use with a dot
 * per hour, sized by the measure; Threads that do not overlap share a row,
 * as the reference's strip packs them.
 */
const tracksOf = (
  threads: ReadonlyArray<UsageDotThread>,
  from: number,
  span: number,
  mode: UsageMeasure,
): {
  readonly tracks: ReadonlyArray<Track>;
  readonly lanes: number;
  readonly maximum: number;
} => {
  const clamp = (value: number) => Math.min(1, Math.max(0, value));
  const placed = threads
    .map((thread) => {
      const hours =
        thread.activity !== undefined && thread.activity.length > 0
          ? thread.activity.map((hour) => ({
              at: clamp(
                (DateTime.toEpochMillis(hour.hour) + HOUR / 2 - from) / span,
              ),
              value:
                mode === "cost" ? hour.estimatedCostMicros : hour.totalTokens,
            }))
          : [
              {
                at: clamp(
                  (DateTime.toEpochMillis(thread.createdAt) - from) / span,
                ),
                value:
                  mode === "cost"
                    ? thread.estimatedCostMicros
                    : thread.totalTokens,
              },
            ];
      const points = hours.toSorted((left, right) => left.at - right.at);
      return {
        thread,
        points,
        start: points[0]?.at ?? 0,
        end: points.at(-1)?.at ?? 0,
      };
    })
    .sort((left, right) => left.start - right.start);
  const laneEnds: Array<number> = [];
  const tracks = placed.map((track) => {
    let lane = laneEnds.findIndex((end) => end + LANE_GAP <= track.start);
    if (lane === -1) {
      lane = laneEnds.length;
      laneEnds.push(track.end);
    } else laneEnds[lane] = track.end;
    return { ...track, lane };
  });
  const maximum = Math.max(
    1,
    ...tracks.flatMap((track) => track.points.map((point) => point.value)),
  );
  return { tracks, lanes: laneEnds.length, maximum };
};

/**
 * The range's days as columns, with each Thread's use across them, as the
 * reference's activity strip draws it.
 */
export function ThreadDotStrip({
  range,
  threads,
  mode,
}: {
  readonly range: { readonly from: string; readonly to: string };
  readonly threads: ReadonlyArray<UsageDotThread>;
  readonly mode: UsageMeasure;
}) {
  const from = Date.parse(`${range.from}T00:00:00.000Z`);
  const to = Date.parse(`${range.to}T23:59:59.999Z`);
  const span = Math.max(1, to - from);
  const days = Math.max(1, Math.round(span / DAY));
  const { tracks, lanes, maximum } = tracksOf(threads, from, span, mode);
  const columns = Array.from({ length: days }, (_, index) => {
    const day = new Date(from + index * DAY);
    return {
      key: isoDate(day),
      weekday: day.toLocaleDateString(USAGE_LOCALE, {
        weekday: "short",
        timeZone: "UTC",
      }),
      date: day.toLocaleDateString(USAGE_LOCALE, {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      }),
      month:
        index === 0 || day.getUTCDate() === 1
          ? day.toLocaleDateString(USAGE_LOCALE, {
              month: "short",
              timeZone: "UTC",
            })
          : "",
      dayOfMonth: day.getUTCDate(),
      weekStart: day.getUTCDay() === 1,
    };
  });
  const labelled = days <= 14;
  return (
    // The card lets a Thread's hover card draw over the date row (#1824).
    <SettingsCard className="usage-strip-card">
      <figure
        className="usage-strip"
        aria-label="Threads by when they used models"
        style={{ "--usage-days": days } as React.CSSProperties}
      >
        <div className="usage-strip-rules" aria-hidden="true">
          {columns
            .slice(1)
            .map((column, index) =>
              labelled || column.weekStart ? (
                <span
                  key={column.key}
                  data-week-start={column.weekStart || undefined}
                  style={{ left: `${((index + 1) / days) * 100}%` }}
                />
              ) : null,
            )}
        </div>
        {labelled ? (
          <div className="usage-strip-days" aria-hidden="true">
            {columns.map((column) => (
              <span key={column.key}>
                <small className="usage-strip-month">{column.month}</small>
                <small>{column.weekday}</small>
                <span className="usage-strip-date">{column.date}</span>
                <span className="usage-strip-day-number">
                  {column.dayOfMonth}
                </span>
              </span>
            ))}
          </div>
        ) : null}
        <div
          className="usage-strip-plot"
          style={{ height: Math.max(64, 12 + lanes * LANE_PX + 8) }}
        >
          {tracks.map((track) => {
            const width = (track.end - track.start) * 100;
            const middle = (track.start + track.end) / 2;
            return (
              <a
                key={track.thread.threadId}
                href={threadHref(track.thread.threadId)}
                className="usage-track"
                // Near an edge the hover card opens inward, so it stays whole.
                data-edge={
                  middle < 0.15 ? "start" : middle > 0.85 ? "end" : undefined
                }
                // On a phone's narrow strip it opens toward the middle.
                data-half={middle < 0.5 ? "start" : "end"}
                style={{
                  left: `${track.start * 100}%`,
                  width: `${width}%`,
                  top: 12 + track.lane * LANE_PX,
                }}
                aria-label={`${track.thread.title}, ${amountLabel(track.thread, mode)}`}
              >
                <span className="usage-track-line" />
                {track.points.map((point) => {
                  const size =
                    2 * (2.25 + 3.25 * Math.sqrt(point.value / maximum));
                  return (
                    <span
                      key={point.at}
                      className="usage-track-dot"
                      style={{
                        left: `${width === 0 ? 0 : ((point.at - track.start) / (track.end - track.start)) * 100}%`,
                        width: size,
                        height: size,
                      }}
                    />
                  );
                })}
                <span className="usage-tooltip">
                  <strong>{track.thread.title}</strong>
                  <span>
                    {usageDay(track.thread.createdAt)},{" "}
                    {usageTime(track.thread.createdAt)}
                  </span>
                  <span>{amountLabel(track.thread, mode)}</span>
                </span>
              </a>
            );
          })}
        </div>
        {labelled ? null : (
          <div className="usage-chart-axis">
            <span>{columns[0]?.date}</span>
            <span>{columns.at(-1)?.date}</span>
          </div>
        )}
      </figure>
    </SettingsCard>
  );
}

/** Name and amount pairs, two to a line on wide screens. */
export function UsageBreakdown({
  title,
  rows,
  mode,
}: {
  readonly title?: string;
  readonly rows: ReadonlyArray<UsageBreakdownRow>;
  readonly mode: UsageMeasure;
}) {
  return rows.length === 0 ? null : (
    <div className="usage-breakdown">
      {title === undefined ? null : <p>{title}</p>}
      <dl>
        {rows.map((row) => (
          <div key={row.key}>
            <dt>{row.name}</dt>
            <dd>{amountLabel(row, mode)}</dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

/**
 * "52k Total Tokens in the last 7 days", then the breakdowns. In Cost, the
 * line also counts turns without a price, so an estimate never hides them.
 */
export function UsageTotalCard({
  total,
  days,
  mode,
  children,
}: {
  readonly total: UsageAmount;
  readonly days: number;
  readonly mode: UsageMeasure;
  readonly children: React.ReactNode;
}) {
  const unpriced = total.unknownCostEvents;
  return (
    <SettingsCard className="usage-total-card">
      <header className="usage-total">
        <h2>{totalLabel(total, mode)}</h2>
        <span>
          in the last {days} days
          {mode === "cost" && unpriced > 0
            ? ` · ${formatCount(unpriced)} model ${unpriced === 1 ? "turn has" : "turns have"} no price`
            : ""}
        </span>
      </header>
      {children}
    </SettingsCard>
  );
}
