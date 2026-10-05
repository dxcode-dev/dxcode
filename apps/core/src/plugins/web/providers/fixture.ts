import type { WebProvider } from "@dx/domain";
import { WEB_SEARCH_DEFAULT_RESULTS } from "../contract.js";

/**
 * Local-runtime substitute for every search provider. It implements the same
 * API with deterministic results and never touches the network, so `pnpm dev`
 * exercises the tools without spending credits. Inputs arrive normalized.
 */
export const createFixtureWebProvider = (): Required<WebProvider> => ({
  async webSearch(input) {
    const count = Math.min(input.max_results ?? WEB_SEARCH_DEFAULT_RESULTS, 3);
    return Array.from({ length: count }, (_, index) => ({
      title: `Local fixture result ${index + 1}`,
      url: `https://fixture.dx.dev/search/${index + 1}`,
      excerpts: [
        `Local development fixture for "${input.objective.slice(0, 200)}". No web request was made.`,
      ],
    }));
  },
  async readWebPage(input) {
    return input.fullContent === true || input.objective === undefined
      ? `# Local fixture page\n\nLocal development fixture for ${input.url}. No web request was made.`
      : `Local development fixture excerpt for ${input.url}. No web request was made.`;
  },
});
