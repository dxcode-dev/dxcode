/**
 * Usage numbers read the same on every device: K, M and B, never a locale's
 * own grouping such as lakh and crore.
 */
export const USAGE_LOCALE = "en-US";

const compactNumber = new Intl.NumberFormat(USAGE_LOCALE, {
  notation: "compact",
  maximumFractionDigits: 1,
});

export const formatTokens = (value: number) => compactNumber.format(value);

export { formatCost } from "../../../shared/usage-cost.js";
