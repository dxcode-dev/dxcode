import { Schema } from "effect";

/**
 * The Search plugin's public API. `web_search` and `read_web_page` take these
 * inputs and return these outputs exactly, and every search provider
 * implements the same functions with the same types. Swapping the provider
 * never changes a tool name, description, parameter, or result shape.
 *
 * The input shapes are fixed field for field. The host normalizes an
 * input before a provider sees it (defaults, limits, URL admission), so a
 * provider receives a valid value of the same type.
 */
export const WebSearchInput = Schema.Struct({
  objective: Schema.String,
  max_results: Schema.optional(Schema.Number),
  search_queries: Schema.optional(Schema.Array(Schema.String)),
});

export type WebSearchInput = typeof WebSearchInput.Type;

export const WebSearchResult = Schema.Struct({
  title: Schema.String,
  url: Schema.String,
  excerpts: Schema.Array(Schema.String),
});

export type WebSearchResult = typeof WebSearchResult.Type;

export const WebSearchOutput = Schema.Array(WebSearchResult);

export type WebSearchOutput = typeof WebSearchOutput.Type;

export const ReadWebPageInput = Schema.Struct({
  url: Schema.String,
  objective: Schema.optional(Schema.String),
  fullContent: Schema.optional(Schema.Boolean),
  forceRefetch: Schema.optional(Schema.Boolean),
  searchQueries: Schema.optional(Schema.Array(Schema.String)),
});

export type ReadWebPageInput = typeof ReadWebPageInput.Type;

/** The page as Markdown: the full page, or excerpts when an objective is set. */
export const ReadWebPageOutput = Schema.String;

export type ReadWebPageOutput = typeof ReadWebPageOutput.Type;

export const WebToolErrorCode = Schema.Literals([
  "invalid_input",
  "unavailable",
  "authentication",
  "quota",
  "rate_limit",
  "timeout",
  "response_too_large",
  "provider_error",
  "target_error",
]);

export class WebToolError extends Schema.TaggedError<WebToolError>()(
  "WebToolError",
  {
    code: WebToolErrorCode,
    message: Schema.String,
    retryAfterSeconds: Schema.optional(Schema.Number),
  },
) {}

/**
 * One search provider. It implements the tool API above, function for
 * function. A provider may implement only one capability; the tools layer
 * exposes only what it implements.
 */
export interface WebProvider {
  readonly webSearch?: (
    input: WebSearchInput,
    signal?: AbortSignal,
  ) => Promise<WebSearchOutput>;
  readonly readWebPage?: (
    input: ReadWebPageInput,
    signal?: AbortSignal,
  ) => Promise<ReadWebPageOutput>;
}
