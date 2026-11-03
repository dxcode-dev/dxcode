export type UsageMode = "tokens" | "cost" | "latency" | "runners";

const compactNumber = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const formatTokens = (value: number) => compactNumber.format(value);

export const formatDuration = (value: number | null) =>
  value === null
    ? "Unknown"
    : value < 1_000
      ? `${Math.round(value)} ms`
      : `${(value / 1_000).toFixed(1)} s`;

export { formatCost } from "../../../shared/usage-cost.js";
