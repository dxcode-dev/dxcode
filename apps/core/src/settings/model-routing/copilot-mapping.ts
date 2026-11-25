import {
  type CopilotCatalogModel,
  githubCopilotCatalog,
} from "../model-subscriptions/github-copilot/catalog.js";
import { findCatalogModel } from "./catalog.js";
import { liveCatalog } from "./live-catalog.js";

/**
 * Canonical mapping for the GitHub Copilot subscription (decision 11):
 * Copilot serves canonical vendor ids where the vendor's pi-ai catalog knows
 * the model — `gpt-*` → `openai/*`, `claude-*` → `anthropic/*` with dot→dash
 * version normalisation, `gemini-*` → `google/*`, `kimi-*` → `moonshotai/*`,
 * `grok-*` → `xai/*`. Everything else stays `github-copilot/<id>`.
 */

const VENDOR_PROVIDERS: ReadonlyArray<{
  readonly prefix: string;
  readonly provider: string;
  /** Vendor catalogs disagree on version punctuation; try alternates. */
  readonly alternates?: (id: string) => ReadonlyArray<string>;
}> = [
  { prefix: "gpt-", provider: "openai" },
  {
    prefix: "claude-",
    provider: "anthropic",
    alternates: (id) => [id, id.replaceAll(".", "-")],
  },
  { prefix: "gemini-", provider: "google" },
  { prefix: "kimi-", provider: "moonshotai" },
  { prefix: "grok-", provider: "xai" },
];

const canonicalForCopilotId = (copilotId: string): string => {
  for (const { prefix, provider, alternates } of VENDOR_PROVIDERS) {
    if (!copilotId.startsWith(prefix)) continue;
    for (const candidate of alternates?.(copilotId) ?? [copilotId]) {
      if (findCatalogModel(provider, candidate) !== undefined) {
        return `${provider}/${candidate}`;
      }
    }
  }
  return `github-copilot/${copilotId}`;
};

export interface CopilotServedModel {
  /** Canonical id this subscription serves. */
  readonly canonical: string;
  /** Copilot-native id sent as `model` upstream. */
  readonly upstream: string;
  readonly name: string;
  readonly protocol: string;
  readonly capabilities: {
    readonly contextWindow: number;
    readonly maxOutputTokens: number;
    readonly reasoning: boolean;
    readonly vision: boolean;
  };
  readonly compatibility: CopilotCatalogModel["compatibility"];
  readonly thinkingLevelMap?: CopilotCatalogModel["thinkingLevelMap"];
}

let served: {
  revision: string;
  models: ReadonlyMap<string, CopilotServedModel>;
} = { revision: "", models: new Map() };

/**
 * Canonical ids a Copilot connection can serve, keyed by canonical id. A
 * canonical maps to at most one Copilot model; the actual serving set is the
 * intersection with the connection's entitlement `modelIds`. Rebuilt when
 * the runtime catalog changes (live-catalog.ts).
 */
export const copilotServedModels = (): ReadonlyMap<
  string,
  CopilotServedModel
> => {
  const { revision } = liveCatalog();
  if (served.revision === revision && served.models.size > 0)
    return served.models;
  const models = new Map(
    githubCopilotCatalog().map((model) => [
      canonicalForCopilotId(model.id),
      {
        canonical: canonicalForCopilotId(model.id),
        upstream: model.id,
        name: model.name,
        protocol: model.protocol,
        capabilities: {
          contextWindow: model.capabilities.contextWindow,
          maxOutputTokens: model.capabilities.maxOutputTokens,
          reasoning: model.capabilities.reasoning,
          vision: model.capabilities.vision,
        },
        compatibility: model.compatibility,
        ...(model.thinkingLevelMap === undefined
          ? {}
          : { thinkingLevelMap: model.thinkingLevelMap }),
      } satisfies CopilotServedModel,
    ]),
  );
  served = { revision, models };
  return models;
};

export const copilotCanonicalFor = (copilotId: string): string | undefined => {
  const model = copilotServedModels().get(canonicalForCopilotId(copilotId));
  return model === undefined || model.upstream !== copilotId
    ? undefined
    : model.canonical;
};

/** Copilot upstream id for a canonical id it can serve, or undefined. */
export const copilotUpstreamFor = (canonical: string): string | undefined =>
  copilotServedModels().get(canonical)?.upstream;

export const copilotModelForCanonical = (
  canonical: string,
): CopilotServedModel | undefined => copilotServedModels().get(canonical);
