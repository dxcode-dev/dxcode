import * as React from "react";
import { cn } from "../utils.js";
import { EmptyState } from "./empty-state.js";
import { AnchoredTooltip } from "./tooltip.js";
import "./time-series-chart.css";

export type TimeSeriesTone =
  | "blue"
  | "green"
  | "orange"
  | "purple"
  | "cyan"
  | "gray";

/** One line, area, or bar segment of the chart. */
export interface TimeSeries {
  readonly id: string;
  readonly label: string;
  /** Defaults to the series' place: blue, green, orange, purple, cyan. */
  readonly tone?: TimeSeriesTone;
}

/** One bucket of time, such as a day, with a value per series. */
export interface TimeSeriesPoint {
  readonly key: string;
  /** Names the bucket on the axis and in the tooltip: "Tue, Nov 18". */
  readonly label: string;
  /** Missing series count as 0. */
  readonly values: Readonly<Record<string, number>>;
}

const TONES: ReadonlyArray<TimeSeriesTone> = [
  "blue",
  "green",
  "orange",
  "purple",
  "cyan",
];

/** One column in the SVG's own units; the SVG stretches to fit. */
const COLUMN = 10;
const BAR = 6;
const HEIGHT = 100;

/** "1,234": the default axis and tooltip format. */
const plainNumber = (value: number) => value.toLocaleString("en-US");

/** The smallest 1, 2, 2.5, or 5 × 10ⁿ at or above `value`. */
const niceCeiling = (value: number) => {
  if (value <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((each) => each * power >= value) ?? 10;
  return step * power;
};

const seriesValue = (point: TimeSeriesPoint, id: string) =>
  point.values[id] ?? 0;

const geometry = (
  points: ReadonlyArray<TimeSeriesPoint>,
  series: ReadonlyArray<TimeSeries>,
  kind: "line" | "area" | "bar",
) => {
  const highest = Math.max(
    0,
    ...points.map((point) =>
      kind === "bar"
        ? series.reduce((sum, each) => sum + seriesValue(point, each.id), 0)
        : Math.max(0, ...series.map((each) => seriesValue(point, each.id))),
    ),
  );
  const top = niceCeiling(highest);
  const y = (value: number) => HEIGHT - (value / top) * HEIGHT;
  const x = (index: number) => index * COLUMN + COLUMN / 2;
  const width = Math.max(1, points.length) * COLUMN;
  return {
    top,
    width,
    y,
    x,
    lines: series.map((each) => {
      const line = points
        .map((point, index) => `${x(index)},${y(seriesValue(point, each.id))}`)
        .join(" ");
      return {
        series: each,
        line,
        area: `${x(0)},${HEIGHT} ${line} ${x(points.length - 1)},${HEIGHT}`,
      };
    }),
    bars: points.flatMap((point, index) => {
      let base = 0;
      return series.map((each) => {
        const value = seriesValue(point, each.id);
        const bottom = base;
        base += value;
        return {
          key: `${point.key}-${each.id}`,
          series: each,
          x: index * COLUMN + (COLUMN - BAR) / 2,
          y: y(bottom + value),
          height: (value / top) * HEIGHT,
        };
      });
    }),
  };
};

/**
 * Values over time, such as daily spend or active people: a line, an
 * area, or stacked bars, one color per series. Each bucket is a focusable
 * column that shows its values on hover or focus, in a tooltip over every
 * pane, so a card's clipping never hides it; arrow keys move between them.
 * `points` undefined shows loading.
 */
export function TimeSeriesChart({
  label,
  series,
  points,
  kind = "line",
  formatValue = plainNumber,
  height = 160,
  empty,
  onPointSelect,
  className,
}: {
  /** Names the chart: "Model spend by day". */
  readonly label: string;
  readonly series: ReadonlyArray<TimeSeries>;
  readonly points: ReadonlyArray<TimeSeriesPoint> | undefined;
  readonly kind?: "line" | "area" | "bar";
  /** Labels the axis and tooltip values: `formatCost`, minutes, counts. */
  readonly formatValue?: (value: number) => string;
  /** The plot's height in pixels. */
  readonly height?: number;
  /** What an empty range says: "No spend in this range." */
  readonly empty?: React.ReactNode;
  /** Makes each column a button that opens its bucket. */
  readonly onPointSelect?: (key: string) => void;
  readonly className?: string;
}) {
  // The hovered or focused column, and its button for the tooltip's anchor.
  const [hovered, setHovered] = React.useState<
    { readonly index: number; readonly anchor: HTMLElement } | undefined
  >();
  const active = hovered?.index;
  const toned = series.map((each, index) => ({
    ...each,
    tone: each.tone ?? TONES[index % TONES.length] ?? "blue",
  }));
  if (points === undefined || points.length === 0) {
    return (
      <figure
        className={cn("dx-chart", className)}
        aria-label={label}
        aria-busy={points === undefined || undefined}
      >
        <div className="dx-chart-plot" data-state="empty" style={{ height }}>
          {points === undefined ? (
            <span className="dx-chart-loading" />
          ) : (
            <EmptyState title={empty ?? "No data in this range."} />
          )}
        </div>
      </figure>
    );
  }
  const plot = geometry(points, toned, kind);
  const activePoint = active === undefined ? undefined : points[active];
  const summary = (point: TimeSeriesPoint) =>
    `${point.label}: ${toned
      .map(
        (each) => `${each.label} ${formatValue(seriesValue(point, each.id))}`,
      )
      .join(", ")}`;
  const middle = Math.floor((points.length - 1) / 2);
  const moveFocus = (
    event: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    const next =
      event.key === "ArrowRight"
        ? index + 1
        : event.key === "ArrowLeft"
          ? index - 1
          : event.key === "Home"
            ? 0
            : event.key === "End"
              ? points.length - 1
              : undefined;
    if (next === undefined || next < 0 || next >= points.length) return;
    event.preventDefault();
    const sibling = event.currentTarget.parentElement?.children[next];
    if (sibling instanceof HTMLElement) sibling.focus();
  };
  return (
    <figure className={cn("dx-chart", className)} aria-label={label}>
      {toned.length > 1 ? (
        <figcaption className="dx-chart-legend">
          {toned.map((each) => (
            <span key={each.id} data-tone={each.tone}>
              {each.label}
            </span>
          ))}
        </figcaption>
      ) : null}
      <div className="dx-chart-axis-y" aria-hidden="true">
        <span>{formatValue(plot.top)}</span>
        <span>{formatValue(plot.top / 2)}</span>
        <span>{formatValue(0)}</span>
      </div>
      <div className="dx-chart-plot" style={{ height }}>
        <div className="dx-chart-rules" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <svg
          className="dx-chart-svg"
          viewBox={`0 0 ${plot.width} ${HEIGHT}`}
          preserveAspectRatio="none"
          aria-hidden="true"
        >
          {kind === "bar"
            ? plot.bars.map((bar) => (
                <rect
                  key={bar.key}
                  data-tone={bar.series.tone}
                  x={bar.x}
                  y={bar.y}
                  width={BAR}
                  height={bar.height}
                />
              ))
            : plot.lines.map((line) => (
                <g key={line.series.id} data-tone={line.series.tone}>
                  {kind === "area" ? (
                    <polygon className="dx-chart-area" points={line.area} />
                  ) : null}
                  <polyline
                    className="dx-chart-line"
                    points={line.line}
                    vectorEffect="non-scaling-stroke"
                  />
                </g>
              ))}
        </svg>
        {active === undefined || activePoint === undefined ? null : (
          <>
            <span
              className="dx-chart-cursor"
              aria-hidden="true"
              style={{ left: `${(plot.x(active) / plot.width) * 100}%` }}
            />
            {kind === "bar"
              ? null
              : toned.map((each) => (
                  <span
                    key={each.id}
                    className="dx-chart-dot"
                    data-tone={each.tone}
                    aria-hidden="true"
                    style={{
                      left: `${(plot.x(active) / plot.width) * 100}%`,
                      top: `${(plot.y(seriesValue(activePoint, each.id)) / HEIGHT) * 100}%`,
                    }}
                  />
                ))}
          </>
        )}
        <fieldset
          className="dx-chart-columns"
          aria-label="Values over time"
          style={{ gridTemplateColumns: `repeat(${points.length}, 1fr)` }}
          onMouseLeave={() => setHovered(undefined)}
        >
          {points.map((point, index) => (
            <button
              key={point.key}
              type="button"
              aria-label={summary(point)}
              tabIndex={index === (active ?? points.length - 1) ? 0 : -1}
              data-active={active === index || undefined}
              data-selectable={onPointSelect === undefined ? undefined : ""}
              onMouseEnter={(event) =>
                setHovered({ index, anchor: event.currentTarget })
              }
              onFocus={(event) =>
                setHovered({ index, anchor: event.currentTarget })
              }
              onBlur={() => setHovered(undefined)}
              onKeyDown={(event) => moveFocus(event, index)}
              onClick={() => onPointSelect?.(point.key)}
            />
          ))}
        </fieldset>
      </div>
      <AnchoredTooltip
        open={activePoint !== undefined}
        anchor={hovered?.anchor ?? null}
        className="dx-chart-tooltip"
      >
        {activePoint === undefined ? null : (
          <>
            <strong>{activePoint.label}</strong>
            {toned.map((each) => (
              <span key={each.id} data-tone={each.tone}>
                <span>{each.label}</span>
                <span>{formatValue(seriesValue(activePoint, each.id))}</span>
              </span>
            ))}
          </>
        )}
      </AnchoredTooltip>
      <div className="dx-chart-axis-x" aria-hidden="true">
        <span>{points[0]?.label}</span>
        {points.length > 2 ? <span>{points[middle]?.label}</span> : null}
        {points.length > 1 ? <span>{points.at(-1)?.label}</span> : null}
      </div>
    </figure>
  );
}
