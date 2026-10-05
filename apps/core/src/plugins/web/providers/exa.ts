import type { WebProvider } from "@dx/domain";
import { WebToolError } from "@dx/domain";
import { Redacted, Schema } from "effect";
import {
  truncationNotice,
  WEB_READ_EXCERPT_CHARACTERS,
  WEB_READ_FULL_CHARACTERS,
  WEB_SEARCH_DEFAULT_RESULTS,
  WEB_SEARCH_MAX_EXCERPT_CHARACTERS,
} from "../contract.js";

const Page = Schema.Struct({
  url: Schema.String,
  title: Schema.optional(Schema.NullOr(Schema.String)),
  text: Schema.optional(Schema.NullOr(Schema.String)),
  highlights: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
});
const ResponseBody = Schema.Struct({
  results: Schema.Array(Page),
  statuses: Schema.optional(
    Schema.Array(
      Schema.Struct({
        status: Schema.String,
        source: Schema.optional(Schema.String),
      }),
    ),
  ),
});
const failure = (code: WebToolError["code"], message: string) =>
  new WebToolError({ code, message });

/**
 * Exa implements the Search plugin's API (`web.search` and `web.read`) behind
 * one API key. It receives inputs the host already normalized and returns the
 * contract's result shapes; it never sees a tool definition.
 */
export const createExaWebProvider = (
  key: Redacted.Redacted<string>,
  transport: typeof fetch = fetch,
): Required<WebProvider> => {
  const request = async (
    path: "search" | "contents",
    body: unknown,
    signal?: AbortSignal,
  ) => {
    const timeout = AbortSignal.timeout(20_000);
    const combined = signal ? AbortSignal.any([signal, timeout]) : timeout;
    try {
      const response = await transport(`https://api.exa.ai/${path}`, {
        method: "POST",
        // Workers reject `redirect: "error"`; "manual" surfaces any 3xx as a
        // non-OK response, which is rejected below without following it.
        redirect: "manual",
        signal: combined,
        headers: {
          "content-type": "application/json",
          "x-api-key": Redacted.value(key),
        },
        body: JSON.stringify(body),
      });
      if (!response.ok) {
        await response.body?.cancel();
        if (response.status === 429) {
          const raw = response.headers.get("retry-after");
          const seconds = raw === null ? NaN : Number(raw);
          throw new WebToolError({
            code: "rate_limit",
            message:
              "Web provider rate limited the request. Do not retry immediately.",
            ...(Number.isFinite(seconds) && seconds >= 0
              ? { retryAfterSeconds: Math.min(seconds, 86_400) }
              : {}),
          });
        }
        throw failure(
          response.status === 401 || response.status === 403
            ? "authentication"
            : response.status === 402
              ? "quota"
              : "provider_error",
          "Web provider rejected the request; no automatic retry was made.",
        );
      }
      const reader = response.body?.getReader();
      if (!reader)
        throw failure(
          "provider_error",
          "Web provider returned no response body.",
        );
      const decoder = new TextDecoder();
      let bytes = 0;
      let text = "";
      try {
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          bytes += part.value.byteLength;
          if (bytes > 1_000_000)
            throw failure(
              "response_too_large",
              "Web provider response exceeded 1 MB.",
            );
          text += decoder.decode(part.value, { stream: true });
        }
        text += decoder.decode();
      } finally {
        await reader.cancel();
      }
      return Schema.decodeUnknownSync(ResponseBody)(JSON.parse(text));
    } catch (error) {
      if (error instanceof WebToolError) throw error;
      throw failure(
        combined.aborted ? "timeout" : "provider_error",
        combined.aborted
          ? "Web request timed out or was cancelled."
          : "Web provider returned an invalid response or could not be reached.",
      );
    }
  };
  return {
    async webSearch(input, signal) {
      const query = [input.objective, ...(input.search_queries ?? [])].join(
        "\n",
      );
      const count = input.max_results ?? WEB_SEARCH_DEFAULT_RESULTS;
      const result = await request(
        "search",
        {
          query,
          type: "auto",
          numResults: count,
          contents: {
            highlights: {
              query,
              maxCharacters: WEB_SEARCH_MAX_EXCERPT_CHARACTERS,
            },
            text: { maxCharacters: 2_000 },
          },
        },
        signal,
      );
      return result.results.slice(0, count).map((page) => {
        const highlights = (page.highlights ?? []).filter(
          (excerpt) => excerpt.trim().length > 0,
        );
        const excerpts =
          highlights.length > 0
            ? highlights
            : page.text?.trim()
              ? [page.text]
              : [];
        return {
          title: (page.title ?? "").slice(0, 1_000),
          url: page.url,
          excerpts: excerpts.map((excerpt) =>
            excerpt.slice(0, WEB_SEARCH_MAX_EXCERPT_CHARACTERS),
          ),
        };
      });
    },
    async readWebPage(input, signal) {
      const full = input.fullContent === true || input.objective === undefined;
      const result = await request(
        "contents",
        {
          urls: [input.url],
          livecrawlTimeout: 15_000,
          // Cached by default; `forceRefetch` asks for a live crawl. A page
          // Exa crawled moments earlier may still report a cached source.
          ...(input.forceRefetch === true ? { maxAgeHours: 0 } : {}),
          ...(full
            ? {
                text: {
                  verbosity: "full",
                  maxCharacters: WEB_READ_FULL_CHARACTERS + 1,
                },
              }
            : {
                highlights: {
                  query: [input.objective, ...(input.searchQueries ?? [])].join(
                    "\n",
                  ),
                  maxCharacters: WEB_READ_EXCERPT_CHARACTERS + 1,
                },
              }),
        },
        signal,
      );
      const status = result.statuses?.[0];
      const page = result.results[0];
      if (
        result.results.length !== 1 ||
        (status && status.status !== "success") ||
        !page
      ) {
        throw failure(
          "target_error",
          "The requested page could not be extracted.",
        );
      }
      const content = full ? page.text : page.highlights?.join("\n\n");
      if (!content?.trim())
        throw failure(
          "target_error",
          "Provider returned no readable content in the requested mode.",
        );
      const limit = full
        ? WEB_READ_FULL_CHARACTERS
        : WEB_READ_EXCERPT_CHARACTERS;
      return content.length > limit
        ? `${content.slice(0, limit)}${truncationNotice(limit)}`
        : content;
    },
  };
};
