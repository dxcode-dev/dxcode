import type { ThreadUsageRoute, ThreadUsageRouteKind } from "@dx/api";

/**
 * How Thread Usage writes amounts, counts, times, and sizes. US grouping on
 * every device, as Usage settings writes them.
 */
const LOCALE = "en-US";

const dollars = (digits: number) =>
  new Intl.NumberFormat(LOCALE, {
    style: "currency",
    currency: "USD",
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
const cents = dollars(2);
const mills = dollars(3);

/** "$0", "<$0.01", or "$0.08": an amount to the cent. */
export const formatUsd = (micros: number) =>
  micros === 0
    ? "$0"
    : micros < 5_000
      ? "<$0.01"
      : cents.format(micros / 1_000_000);

/** "$0", "<$0.001", or "$0.080": Orb time and credits, to a tenth of a cent. */
export const formatUsdMills = (micros: number) =>
  micros === 0
    ? "$0"
    : micros < 500
      ? "<$0.001"
      : mills.format(micros / 1_000_000);

const counts = new Intl.NumberFormat(LOCALE);
export const formatCount = (value: number) => counts.format(value);

/** "6.3" for a share of a whole, to one decimal. */
export const formatPercent = (part: number, whole: number) =>
  whole <= 0 ? "0" : ((part / whole) * 100).toFixed(1);

/**
 * Input split the way providers bill it: uncached input, cache writes, and
 * cache reads, which dx records apart (Anthropic's `input_tokens` leaves out
 * both cache fields). A cache write is a cache miss, billed above uncached
 * input, so only cache reads count as cached.
 */
export interface InputTokenCounts {
  readonly uncached: number;
  readonly cacheWrite: number;
  readonly cacheRead: number;
}

export const totalInput = (input: InputTokenCounts) =>
  input.uncached + input.cacheWrite + input.cacheRead;

/** "10 uncached · 327,571 cache write · 36,765 cache read", or undefined with no cache use. */
export const formatInputBreakdown = (input: InputTokenCounts) =>
  input.cacheWrite === 0 && input.cacheRead === 0
    ? undefined
    : `${formatCount(input.uncached)} uncached · ${formatCount(input.cacheWrite)} cache write · ${formatCount(input.cacheRead)} cache read`;

/** "8.5s", "14m27.752s", or "1h02m03.004s". */
export const formatDuration = (ms: number) => {
  if (ms < 60_000) return `${Number((ms / 1_000).toFixed(3))}s`;
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  const seconds = ((ms % 60_000) / 1_000).toFixed(3).padStart(6, "0");
  return hours === 0
    ? `${minutes}m${seconds}s`
    : `${hours}h${String(minutes).padStart(2, "0")}m${seconds}s`;
};

const instant = new Intl.DateTimeFormat(LOCALE, {
  month: "short",
  day: "numeric",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  fractionalSecondDigits: 3,
  hour12: true,
});

/** "Nov 10, 03:16:19.822 AM", in the viewer's time zone. */
export const formatInstant = (value: string | number) =>
  instant.format(new Date(value));

/** "4 vCPU, 8 GiB RAM"; either part is left out when unknown. */
export const formatOrbSize = (
  cpuCores: number | null,
  memoryMb: number | null,
) =>
  [
    cpuCores === null ? undefined : `${cpuCores} vCPU`,
    memoryMb === null
      ? undefined
      : `${Number((memoryMb / 1_024).toFixed(2))} GiB RAM`,
  ]
    .filter((part) => part !== undefined)
    .join(", ");

/** "503 MiB", or "1.25 GiB" from a gibibyte up. */
export const formatBytes = (bytes: number) => {
  const mebibytes = bytes / 1_048_576;
  return mebibytes >= 1_024
    ? `${(mebibytes / 1_024).toFixed(2)} GiB`
    : `${formatCount(Math.round(mebibytes))} MiB`;
};

/** What kind of connection a route is, as a sentence names it. */
export const ROUTE_KIND_LABELS: Record<ThreadUsageRouteKind, string> = {
  deployment: "dx deployment",
  custom: "Custom URL",
  provider: "API key",
  subscription: "subscription",
  "claude-code": "Claude plan",
  unknown: "removed connection",
};

const capitalized = (text: string) =>
  `${text.charAt(0).toUpperCase()}${text.slice(1)}`;

/** "A, B, and C". */
const listed = (parts: ReadonlyArray<string>) =>
  parts.length < 3
    ? parts.join(" and ")
    : `${parts.slice(0, -1).join(", ")}, and ${parts.at(-1)}`;

/**
 * "Your personal Custom URL and your workspace API key were used for some
 * inference, with an estimated token list price of $0.02.", for the keys
 * and plans people brought that ran priced turns; undefined without one.
 */
export const byokSentence = (routes: ReadonlyArray<ThreadUsageRoute>) => {
  const brought = routes.filter(
    (route) => route.kind !== "deployment" && route.listPriceMicros > 0,
  );
  if (brought.length === 0) return undefined;
  const names = [
    ...new Set(
      brought.map((route) =>
        route.scope === null
          ? `a ${ROUTE_KIND_LABELS[route.kind]}`
          : `your ${route.scope} ${ROUTE_KIND_LABELS[route.kind]}`,
      ),
    ),
  ];
  const price = brought.reduce((sum, route) => sum + route.listPriceMicros, 0);
  return `${capitalized(listed(names))} ${names.length === 1 ? "was" : "were"} used for some inference, with an estimated token list price of ${formatUsd(price)}.`;
};

/** "Custom URL", for the start of a route's source line. */
export const routeKindTitle = (kind: ThreadUsageRouteKind) =>
  capitalized(ROUTE_KIND_LABELS[kind]);

/**
 * Where a Thread's model routes came from, for Model Routing's sentence:
 * the settings scopes its rows name, and this deployment's own connection
 * when it served any.
 */
export const routingSource = (routes: ReadonlyArray<ThreadUsageRoute>) => {
  const scopes = (["personal", "workspace"] as const).filter((scope) =>
    routes.some(
      (route) => route.kind !== "deployment" && route.scope === scope,
    ),
  );
  const deployment = routes.some((route) => route.kind === "deployment");
  const settings =
    scopes.length === 0
      ? undefined
      : `the connections in your ${scopes.join(" and ")} Model Routing settings`;
  const own = deployment ? "this deployment's model connection" : undefined;
  return (
    [settings, own].filter((part) => part !== undefined).join(" and ") ||
    "connections removed since"
  );
};
