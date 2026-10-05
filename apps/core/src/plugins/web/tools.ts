import {
  type PluginCapabilityId,
  ReadWebPageOutput,
  type WebProvider,
  WebSearchOutput,
  WebToolError,
} from "@dx/domain";
import { defineTool } from "@flue/runtime";
import { Schema } from "effect";
import * as v from "valibot";
import {
  type AdmittedConfiguration,
  admitPluginCall,
  meterPluginCall,
  type PluginCallAdmission,
  type PluginCallMeter,
  type PluginHostContext,
  type PluginSubmission,
  type ThreadPlugin,
} from "../host.js";
import { isLocalRuntime } from "../registry.js";
import {
  admitSearchResults,
  normalizeReadWebPageInput,
  normalizeWebSearchInput,
} from "./contract.js";
import { READ_WEB_PAGE_TOOL, WEB_SEARCH_TOOL } from "./definitions.js";
import { createExaWebProvider } from "./providers/exa.js";
import { createFixtureWebProvider } from "./providers/fixture.js";

const unavailableMessages: Record<
  Extract<PluginCallAdmission, { admitted: false }>["reason"],
  string
> = {
  "thread-unavailable": "This Thread cannot use Search right now.",
  "not-installed": "Search is not installed on this deployment.",
  disabled: "Search is disabled in settings.",
  "no-provider":
    "Search has no provider configured right now. Add a key in Settings → Plugins.",
  "capability-unavailable":
    "The current Search provider does not offer this tool.",
  "credential-unavailable": "The Search provider credential is unavailable.",
};

/**
 * Builds the provider implementation for an admitted configuration. Local
 * runtime always gets the fixture. The meter counts requests that reach the
 * provider: every Exa HTTP request, or one per fixture operation.
 */
export const webProviderFor = (
  configuration: AdmittedConfiguration,
  bindings: PluginHostContext["bindings"],
  meter: PluginCallMeter,
  transport: typeof fetch = fetch,
): WebProvider => {
  if (isLocalRuntime(bindings)) {
    const fixture = createFixtureWebProvider();
    return {
      webSearch: (input, signal) => {
        meter.add(1);
        return fixture.webSearch(input, signal);
      },
      readWebPage: (input, signal) => {
        meter.add(1);
        return fixture.readWebPage(input, signal);
      },
    };
  }
  switch (configuration.providerId) {
    case "exa":
      if (configuration.credential === undefined) return {};
      return createExaWebProvider(configuration.credential, (input, init) => {
        meter.add(1);
        return transport(input, init);
      });
    case "fixture":
    case "quickjs":
    case "sarvam":
    case "e2b":
    case "cloudflare":
    case "local":
      return {};
  }
};

export type WebCapabilityInvoker = <T>(
  capability: PluginCapabilityId,
  call: (provider: WebProvider) => Promise<T>,
) => Promise<T>;

/** Call-time path: admit, build the provider, call, meter. Fails closed. */
export const webCapabilityInvoker =
  (
    getContext: () => PluginHostContext,
    submission: PluginSubmission,
    threadPlugin: ThreadPlugin,
    transport: typeof fetch = fetch,
  ): WebCapabilityInvoker =>
  async (capability, call) => {
    const context = getContext();
    const admission = await admitPluginCall(
      context,
      submission.threadId,
      threadPlugin,
      capability,
    );
    if (!admission.admitted)
      throw new WebToolError({
        code: "unavailable",
        message: unavailableMessages[admission.reason],
      });
    return meterPluginCall(
      context,
      submission.threadId,
      submission.submissionId,
      threadPlugin,
      capability,
      admission.configuration,
      (meter) =>
        call(
          webProviderFor(
            admission.configuration,
            context.bindings,
            meter,
            transport,
          ),
        ),
    );
  };

/** A provider's result must match the public API before the model sees it. */
const decodeOutput = <
  S extends Schema.Top & { readonly DecodingServices: never },
>(
  schema: S,
  value: unknown,
): S["Type"] => {
  try {
    return Schema.decodeUnknownSync(schema)(value);
  } catch {
    throw new WebToolError({
      code: "provider_error",
      message: "Web provider returned a result outside the Search API.",
    });
  }
};

const unavailable = () =>
  new WebToolError({
    code: "unavailable",
    message: "The configured Search provider does not offer this tool.",
  });

const described = <S extends v.GenericSchema>(schema: S, description: string) =>
  v.pipe(schema, v.description(description));

const search = WEB_SEARCH_TOOL.parameters;
const read = READ_WEB_PAGE_TOOL.parameters;

/**
 * `web_search` and `read_web_page`, mounted only for the capabilities in the
 * submission's tool set. Names, descriptions, parameters, and result shapes
 * are the Search plugin's public API, verbatim, and never change
 * with the provider. Limits are enforced by normalizing the input before
 * admission, so a rejected input is never metered.
 */
export const createWebTools = (
  capabilities: ReadonlyArray<PluginCapabilityId>,
  invoke: WebCapabilityInvoker,
) => [
  ...(capabilities.includes("web.search")
    ? [
        defineTool({
          name: WEB_SEARCH_TOOL.name,
          description: WEB_SEARCH_TOOL.description,
          input: v.object({
            objective: described(v.string(), search.objective),
            max_results: v.optional(described(v.number(), search.max_results)),
            search_queries: v.optional(
              described(v.array(v.string()), search.search_queries),
            ),
          }),
          run: async ({ data, signal }) => {
            const input = normalizeWebSearchInput(data);
            const results = await invoke("web.search", async (provider) => {
              if (provider.webSearch === undefined) throw unavailable();
              return decodeOutput(
                WebSearchOutput,
                await provider.webSearch(input, signal),
              );
            });
            return {
              output: admitSearchResults(
                results,
                input.max_results ?? results.length,
              ),
            };
          },
        }),
      ]
    : []),
  ...(capabilities.includes("web.read")
    ? [
        defineTool({
          name: READ_WEB_PAGE_TOOL.name,
          description: READ_WEB_PAGE_TOOL.description,
          input: v.object({
            url: described(v.string(), read.url),
            objective: v.optional(described(v.string(), read.objective)),
            fullContent: v.optional(described(v.boolean(), read.fullContent)),
            forceRefetch: v.optional(described(v.boolean(), read.forceRefetch)),
            searchQueries: v.optional(
              described(v.array(v.string()), read.searchQueries),
            ),
          }),
          run: async ({ data, signal }) => {
            const input = normalizeReadWebPageInput(data);
            return {
              output: await invoke("web.read", async (provider) => {
                if (provider.readWebPage === undefined) throw unavailable();
                return decodeOutput(
                  ReadWebPageOutput,
                  await provider.readWebPage(input, signal),
                );
              }),
            };
          },
        }),
      ]
    : []),
];
