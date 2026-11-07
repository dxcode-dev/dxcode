import { DateTime } from "effect";
import { modelDisplayName } from "../../../shared/model-display-name.js";
import { formatCost, formatTokens, USAGE_LOCALE } from "./usage-format.js";

/** Values and labels that personal, workspace and Orb Usage share. */

export type UsageMeasure = "tokens" | "cost";
export const USAGE_RANGES = [7, 14, 30, 90] as const;
export type UsageRange = (typeof USAGE_RANGES)[number];

const isoDate = (date: Date) => date.toISOString().slice(0, 10);

/** The last `days` UTC days, today included: day boundaries are UTC. */
export const utcRange = (days: number) => {
  const to = new Date();
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - (days - 1));
  return { from: isoDate(from), to: isoDate(to), timezoneOffsetMinutes: 0 };
};

export interface UsageAmount {
  readonly totalTokens: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly modelTurns: number;
}

/** An amount in the chosen measure; cost is unknown only when no turn was priced. */
export const amountLabel = (value: UsageAmount, mode: UsageMeasure) =>
  mode === "tokens"
    ? `${formatTokens(value.totalTokens)} tokens`
    : value.unknownCostEvents > 0 &&
        value.unknownCostEvents === value.modelTurns
      ? "Unknown"
      : value.estimatedCostMicros === 0
        ? "$0"
        : formatCost(value.estimatedCostMicros);

export const totalLabel = (value: UsageAmount, mode: UsageMeasure) =>
  mode === "tokens"
    ? `${formatTokens(value.totalTokens)} Total Tokens`
    : `${amountLabel(value, "cost")} Total Cost`;

export interface UsageBreakdownRow extends UsageAmount {
  readonly key: string;
  readonly name: string;
}

export interface UsageModelRow extends UsageAmount {
  readonly providerId: string;
  readonly providerName: string;
  readonly modelId: string;
  readonly modelName: string;
}

/** Model rows summed by the provider that answered them. */
export const providerRows = (
  models: ReadonlyArray<UsageModelRow>,
): ReadonlyArray<UsageBreakdownRow> => {
  const providers = new Map<string, UsageBreakdownRow>();
  for (const model of models) {
    const total = providers.get(model.providerId);
    providers.set(model.providerId, {
      key: model.providerId,
      name: model.providerName,
      totalTokens: (total?.totalTokens ?? 0) + model.totalTokens,
      estimatedCostMicros:
        (total?.estimatedCostMicros ?? 0) + model.estimatedCostMicros,
      unknownCostEvents:
        (total?.unknownCostEvents ?? 0) + model.unknownCostEvents,
      modelTurns: (total?.modelTurns ?? 0) + model.modelTurns,
    });
  }
  return [...providers.values()];
};

export const modelRows = (
  models: ReadonlyArray<UsageModelRow>,
): ReadonlyArray<UsageBreakdownRow> =>
  models.map((model) => ({
    ...model,
    key: `${model.providerId}/${model.modelId}`,
    name: modelDisplayName(model.modelName),
  }));

export const usageDay = (value: DateTime.Utc) =>
  new Date(DateTime.toEpochMillis(value)).toLocaleString(USAGE_LOCALE, {
    weekday: "short",
    month: "short",
    day: "numeric",
  });

export const usageTime = (value: DateTime.Utc) =>
  new Date(DateTime.toEpochMillis(value)).toLocaleTimeString(USAGE_LOCALE, {
    hour: "2-digit",
    minute: "2-digit",
  });

/** "2d7h58m", "26h1m", "6m": the largest units, no zeros in front. */
export const compactDuration = (milliseconds: number) => {
  const minutes = Math.floor(milliseconds / 60_000);
  if (minutes < 1) return "<1m";
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  return days > 0
    ? `${days}d${hours}h${rest}m`
    : hours > 0
      ? `${hours}h${rest}m`
      : `${rest}m`;
};

export const downloadCsv = (exported: {
  readonly content: string;
  readonly contentType: string;
  readonly filename: string;
}) => {
  const url = URL.createObjectURL(
    new Blob([exported.content], { type: exported.contentType }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

/** The days a loaded range covers, so every part reads the same range. */
export const rangeDays = (range: {
  readonly from: string;
  readonly to: string;
}) =>
  Math.round(
    (Date.parse(`${range.to}T00:00:00.000Z`) -
      Date.parse(`${range.from}T00:00:00.000Z`)) /
      86_400_000,
  ) + 1;

/** A whole count with US grouping (1,234,567), whatever the device locale. */
export const formatCount = (value: number) =>
  value.toLocaleString(USAGE_LOCALE);
