/**
 * An estimated usage cost in US dollars, from millionths of a dollar: four
 * decimals under a cent, so a small cost does not read as $0.00. Always US
 * grouping, whatever the device locale.
 */
export const formatCost = (micros: number) =>
  new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: micros < 10_000 ? 4 : 2,
    maximumFractionDigits: micros < 10_000 ? 4 : 2,
  }).format(micros / 1_000_000);
