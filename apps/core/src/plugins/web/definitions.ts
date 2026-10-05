/**
 * The Search plugin's tool definitions for `web_search` and
 * `read_web_page`: names, descriptions, and per-parameter descriptions, fixed
 * verbatim. They
 * are part of the plugin's public API and never change with the provider.
 * `read_web_page` names `shell_command` on purpose; dx is moving its shell
 * tool to that name.
 */
export const WEB_SEARCH_TOOL = {
  name: "web_search",
  description:
    'Search the web for information relevant to a research objective.\n\nUse when the task depends on up-to-date or precise external information that is unavailable in the provided context, local workspace, or repository sources. Do not use it for general background, definitions, examples, incidental terms, or to reinforce an answer already supported by available evidence.\n\nFor related query variants, make one call and put 2-3 short queries in `search_queries`. Do not issue parallel calls that rephrase or broaden the same objective. Inspect the results before making a follow-up call; a follow-up must target a specific unresolved fact. Parallel calls are only appropriate for multiple independent external questions that are each necessary to the task.\n\nUse `read_web_page` to fetch full content from a specific URL.\n\n# Examples\n\nGet API documentation for a specific provider\n```json\n{"objective":"I want to know the request fields for the Stripe billing create customer API. Prefer Stripe\'s docs site."}\n```\n\nSee usage documentation for newly released library features\n```json\n{"objective":"I want to know how to use SvelteKit remote functions, which is a new feature shipped in the last month.","search_queries":["sveltekit","remote function"]}\n```\n',
  parameters: {
    objective:
      "A natural-language description of the broader task or research goal, including any source or freshness guidance",
    max_results: "The maximum number of results to return (default: 5)",
    search_queries:
      "Optional 2-3 short keyword queries to prioritize related terms within this single search call",
  },
} as const;

export const READ_WEB_PAGE_TOOL = {
  name: "read_web_page",
  description:
    'Read the contents of a web page at a given URL.\n\nWhen only the url parameter is set, it returns the contents of the webpage converted to Markdown.\n\nWhen an objective is provided, it returns excerpts relevant to that objective. Excerpts are selected by relevance to the objective, not by reasoning: they work well for lookups and summaries, but for verification, error-finding, cross-checking numbers or tables, or auditing a document they can silently omit the passages you need. For those tasks, set `fullContent: true` (or omit `objective`) to read the whole page.\n\nIf the user asks for the latest or recent contents, or the page contains time-sensitive data (scores, prices, leaderboards), pass `forceRefetch: true` to ensure the latest content is fetched.\n\nDo NOT use for access to localhost or any other local or non-Internet-accessible URLs; use `curl` via shell_command instead.\n\n# Examples\n\nSummarize recent changes for a library. Force refresh because freshness is important.\n```json\n{"url":"https://example.com/changelog","objective":"I am upgrading from v2 to v3 of this library. Summarize the breaking API changes and migration steps.","searchQueries":["breaking changes","migration guide"],"forceRefetch":true}\n```\n\nVerify numbers in a paper. Full content because excerpts could omit the passages being cross-checked.\n```json\n{"url":"https://example.com/papers/benchmark-study","objective":"Cross-check the reported accuracy scores between the abstract and the tables.","fullContent":true}\n```\n\nExtract all text content from a web page\n```json\n{"url":"https://example.com/docs/getting-started"}\n```\n',
  parameters: {
    url: "The URL of the web page to read",
    objective:
      'A self-contained, natural-language description of what you are looking for, including the broader task context — not just keywords (e.g. "I am verifying benchmark scores reported in this paper; find the stated accuracy numbers for each model" rather than "accuracy numbers"). If set, only relevant excerpts will be returned unless fullContent is also set. If not set, the full content of the web page will be returned.',
    fullContent:
      "Return the full page content as Markdown even when an objective is set. Use for verification, cross-checking, or auditing tasks where relevance-ranked excerpts could omit important passages.",
    forceRefetch:
      "Force a live fetch of the URL (default: use a cached version that may be a few days old)",
    searchQueries:
      "Optional 2-3 short keyword queries (3-6 words each) to emphasize specific terms when selecting excerpts. Use together with objective when the objective alone may be ambiguous.",
  },
} as const;
