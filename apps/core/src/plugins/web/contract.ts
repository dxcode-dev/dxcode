import {
  type ReadWebPageInput,
  type WebSearchInput,
  type WebSearchOutput,
  WebToolError,
} from "@dx/domain";

/**
 * Host policy for the Search plugin, applied before any provider runs. The
 * tool schemas are fixed and carry no limits, so the limits live
 * here and apply identically to every provider.
 */
export const WEB_SEARCH_DEFAULT_RESULTS = 5;
export const WEB_SEARCH_MAX_RESULTS = 10;
export const WEB_MAX_QUERIES = 3;
export const WEB_MAX_TEXT_LENGTH = 2_000;
export const WEB_MAX_URL_LENGTH = 2_048;
export const WEB_SEARCH_MAX_EXCERPT_CHARACTERS = 4_000;
export const WEB_READ_FULL_CHARACTERS = 100_000;
export const WEB_READ_EXCERPT_CHARACTERS = 20_000;

/** Marks content the tool cut at its limit; the model sees it as text. */
export const truncationNotice = (limit: number) =>
  `\n\n[Content truncated at ${limit.toLocaleString("en-US")} characters.]`;

const invalid = (message: string) =>
  new WebToolError({ code: "invalid_input", message });

// dx never fetches target URLs itself; only the provider's fixed endpoint
// receives the key. Literal and local targets are rejected before any provider
// call. Provider-side DNS and redirect admission remain the provider's
// responsibility, not a claimed dx DNS-rebinding defense.
export const publicWebUrl = (value: string): string => {
  if (value.length > WEB_MAX_URL_LENGTH)
    throw invalid("URL exceeds 2,048 characters.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw invalid("Use a public HTTP(S) URL.");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (
    !["https:", "http:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    (url.port !== "" && url.port !== "80" && url.port !== "443") ||
    !host.includes(".") ||
    host.includes(":") ||
    /^\d+\.\d+\.\d+\.\d+$/.test(host) ||
    /(?:^|\.)(?:localhost|local|internal|test|invalid|example|onion)$/.test(
      host,
    )
  ) {
    throw invalid(
      "Use a public hostname without credentials or nonstandard ports; IP literals and local targets are not supported.",
    );
  }
  url.hash = "";
  return url.href;
};

const text = (value: string, label: string) => {
  const trimmed = value.trim();
  if (trimmed.length === 0) throw invalid(`${label} must not be empty.`);
  if (trimmed.length > WEB_MAX_TEXT_LENGTH)
    throw invalid(`${label} exceeds 2,000 characters.`);
  return trimmed;
};

/** Up to three non-empty queries; extra queries are ignored, not rejected. */
const queries = (values: ReadonlyArray<string> | undefined) =>
  (values ?? [])
    .filter((value) => value.trim().length > 0)
    .slice(0, WEB_MAX_QUERIES)
    .map((value) => text(value, "A search query"));

export const normalizeWebSearchInput = (
  input: WebSearchInput,
): WebSearchInput => {
  const requested = input.max_results;
  return {
    objective: text(input.objective, "objective"),
    max_results:
      requested === undefined || !Number.isFinite(requested)
        ? WEB_SEARCH_DEFAULT_RESULTS
        : Math.min(WEB_SEARCH_MAX_RESULTS, Math.max(1, Math.round(requested))),
    search_queries: queries(input.search_queries),
  };
};

export const normalizeReadWebPageInput = (
  input: ReadWebPageInput,
): ReadWebPageInput => ({
  url: publicWebUrl(input.url.trim()),
  ...(input.objective === undefined || input.objective.trim() === ""
    ? {}
    : { objective: text(input.objective, "objective") }),
  fullContent: input.fullContent === true,
  forceRefetch: input.forceRefetch === true,
  searchQueries: queries(input.searchQueries),
});

/** Results keep the contract shape and never expose an unsafe source URL. */
export const admitSearchResults = (
  results: WebSearchOutput,
  maxResults: number,
): WebSearchOutput =>
  results
    .flatMap((result) => {
      try {
        return [{ ...result, url: publicWebUrl(result.url) }];
      } catch {
        return [];
      }
    })
    .slice(0, maxResults);
