import type { DataViewFormat } from "@dx/domain";

/**
 * A state value as text. State is the plugin's data: it is always drawn as
 * text, never as markup.
 */

const number = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });
const percent = new Intl.NumberFormat("en-US", {
  style: "percent",
  maximumFractionDigits: 1,
});
const money = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
});

const bytes = (value: number) => {
  const units = ["B", "KB", "MB", "GB", "TB"];
  let size = value;
  let unit = 0;
  while (Math.abs(size) >= 1024 && unit < units.length - 1) {
    size /= 1024;
    unit += 1;
  }
  return `${number.format(size)} ${units[unit]}`;
};

const duration = (ms: number) =>
  ms < 1_000
    ? `${number.format(ms)} ms`
    : ms < 60_000
      ? `${number.format(ms / 1_000)} s`
      : ms < 3_600_000
        ? `${number.format(ms / 60_000)} min`
        : `${number.format(ms / 3_600_000)} h`;

export const formatViewValue = (
  value: unknown,
  format: DataViewFormat = "text",
): string => {
  if (value === undefined || value === null) return "";
  if (typeof value === "number" && Number.isFinite(value))
    switch (format) {
      case "percent":
        return percent.format(value);
      case "bytes":
        return bytes(value);
      case "duration":
        return duration(value);
      case "money":
        return money.format(value);
      case "number":
        return number.format(value);
      default:
        return String(value);
    }
  if (format === "time" && typeof value === "string") {
    const time = Date.parse(value);
    return Number.isNaN(time)
      ? value
      : new Date(time).toLocaleString(undefined, {
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        });
  }
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return JSON.stringify(value);
};

/** A number from a state value, for charts and changes. */
export const numberOf = (value: unknown): number | undefined => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
};
