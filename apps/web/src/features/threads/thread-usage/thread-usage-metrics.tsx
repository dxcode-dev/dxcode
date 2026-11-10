import type {
  ThreadDetailData,
  ThreadOrbMetricSample,
  ThreadOrbMetricsData,
} from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { SettingsCard } from "../../../shared/ui/settings.js";
import {
  formatBytes,
  formatCount,
  formatPercent,
} from "./thread-usage-format.js";
import { threadOrbMetricsQueryOptions } from "./thread-usage-queries.js";

/** The chart's width in the SVG's own units; the SVG stretches to fit. */
const WIDTH = 1_000;
const HEIGHT = 100;

const SERIES = [
  ["cpu", "CPU", "cpuPercent"],
  ["memory", "Memory", "memoryPercent"],
  ["disk", "Disk", "diskPercent"],
] as const;

/**
 * Each series' lines across the samples, by time: a gap in its samples
 * breaks its line. A series with no samples is left out.
 */
const linesOf = (samples: ReadonlyArray<ThreadOrbMetricSample>) => {
  const first = samples[0]?.at ?? 0;
  const span = (samples.at(-1)?.at ?? 0) - first;
  const x = (sample: ThreadOrbMetricSample, index: number) =>
    span > 0
      ? ((sample.at - first) / span) * WIDTH
      : samples.length > 1
        ? (index / (samples.length - 1)) * WIDTH
        : WIDTH;
  return SERIES.flatMap(([kind, label, field]) => {
    const segments: Array<Array<readonly [number, number]>> = [];
    let current: Array<readonly [number, number]> = [];
    samples.forEach((sample, index) => {
      const value = sample[field];
      if (value === null) {
        if (current.length > 0) segments.push(current);
        current = [];
        return;
      }
      current.push([
        x(sample, index),
        HEIGHT - Math.min(100, Math.max(0, value)),
      ]);
    });
    if (current.length > 0) segments.push(current);
    if (segments.length === 0) return [];
    return [
      {
        kind,
        label,
        // A lone sample draws as a short flat stroke, so it shows.
        lines: segments.map((points) =>
          (points.length === 1 && points[0] !== undefined
            ? [
                [Math.max(0, points[0][0] - 4), points[0][1]] as const,
                points[0],
              ]
            : points
          )
            .map(([px, py]) => `${px},${py}`)
            .join(" "),
        ),
      },
    ];
  });
};

/**
 * CPU, memory, and disk sampled from the Thread's Orb: its memory
 * percentiles and peak, and a chart in percent of the Orb's capacity.
 */
export function OrbMetricsCard({
  threadId,
  hasOrb,
}: {
  readonly threadId: ThreadDetailData["id"];
  readonly hasOrb: boolean;
}) {
  const { identity } = useAuthenticatedIdentity();
  const metrics = useQuery(threadOrbMetricsQueryOptions(identity.id, threadId));
  const data = metrics.data;
  if (data === undefined ? !hasOrb : data.samples.length === 0) return null;
  return (
    <SettingsCard
      title="Orb System Metrics"
      description="CPU, memory, and disk sampled from this thread's Orb."
      className="thread-usage-card thread-usage-metrics"
    >
      <div className="thread-usage-section">
        {data === undefined ? (
          <p className="thread-usage-unavailable">
            {metrics.isError
              ? "Orb metrics could not load."
              : "Loading Orb metrics…"}
          </p>
        ) : (
          <OrbMetrics data={data} />
        )}
      </div>
    </SettingsCard>
  );
}

function OrbMetrics({ data }: { readonly data: ThreadOrbMetricsData }) {
  const memory = data.memory;
  const count = memory?.samples ?? data.samples.length;
  const share = (bytes: number) =>
    memory === null
      ? formatBytes(bytes)
      : `${formatBytes(bytes)} (${formatPercent(bytes, memory.totalBytes)}%)`;
  const series = linesOf(data.samples);
  return (
    <>
      {data.orbId === null ? null : (
        <p className="thread-usage-orb-id">
          <span>Orb</span>
          <code>{data.orbId}</code>
        </p>
      )}
      {memory === null ? null : (
        <div className="thread-usage-boxes">
          <div className="thread-usage-box">
            <span>Memory p50</span>
            <strong>{share(memory.p50Bytes)}</strong>
          </div>
          <div className="thread-usage-box">
            <span>Memory p99</span>
            <strong>{share(memory.p99Bytes)}</strong>
          </div>
          <div className="thread-usage-box">
            <span>Sampled peak</span>
            <strong>{share(memory.peakBytes)}</strong>
          </div>
          <div className="thread-usage-box">
            <span>Samples</span>
            <strong>{formatCount(count)}</strong>
          </div>
        </div>
      )}
      <p>
        Percentiles and peak are based on {formatCount(count)}{" "}
        {count === 1 ? "sample" : "samples"}. Short spikes between samples may
        not be captured.
      </p>
      <figure className="thread-usage-chart">
        <div className="thread-usage-plot">
          <span className="thread-usage-axis" style={{ top: "0%" }}>
            100%
          </span>
          <span className="thread-usage-axis" style={{ top: "50%" }}>
            50%
          </span>
          <span className="thread-usage-axis" style={{ top: "100%" }}>
            0%
          </span>
          <svg
            viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
            preserveAspectRatio="none"
            role="img"
            aria-label={`${series.map((entry) => entry.label).join(", ")} use in percent over ${formatCount(data.samples.length)} samples`}
          >
            {[0, 50, 100].map((y) => (
              <line
                key={y}
                className="thread-usage-grid"
                x1={0}
                x2={WIDTH}
                y1={y}
                y2={y}
                vectorEffect="non-scaling-stroke"
              />
            ))}
            {series.flatMap((entry) =>
              entry.lines.map((points, index) => (
                <polyline
                  // biome-ignore lint/suspicious/noArrayIndexKey: a series' segments keep their order.
                  key={`${entry.kind}-${index}`}
                  className="thread-usage-line"
                  data-series={entry.kind}
                  points={points}
                  vectorEffect="non-scaling-stroke"
                />
              )),
            )}
          </svg>
        </div>
        <figcaption>
          <ul className="thread-usage-chart-legend">
            {series.map((entry) => (
              <li key={entry.kind} data-series={entry.kind}>
                {entry.label}
              </li>
            ))}
          </ul>
        </figcaption>
      </figure>
    </>
  );
}
