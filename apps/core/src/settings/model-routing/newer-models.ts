import type { Api, Model } from "@earendil-works/pi-ai";
import { getBuiltinModels } from "@earendil-works/pi-ai/providers/all";

type BuiltinProviderId = Parameters<typeof getBuiltinModels>[0];
type Cost = Model<Api>["cost"];

/**
 * A model its vendor released after the pinned pi catalog snapshot. It takes
 * every wire trait (api, compat, headers, thinking map, limits) from its
 * predecessor on the same pi provider, so it is served exactly like a model
 * that provider already runs, and overrides only what the vendor published:
 * its id, name and price.
 */
interface Successor {
  /** pi catalog provider id. */
  readonly provider: string;
  readonly predecessor: string;
  readonly id: string;
  readonly name: string;
  /** USD per million tokens; cacheWrite is the 5-minute write price. */
  readonly cost: Cost;
}

const cost = (
  input: number,
  output: number,
  cacheRead: number,
  cacheWrite: number,
): Cost => ({ input, output, cacheRead, cacheWrite });

/**
 * Claude Fable 5.2 (released 2026-11-09). Anthropic price
 * (platform.claude.com/docs/en/about-claude/pricing): $8 input, $10 5-minute
 * cache write, $0.20 cache read, $40 output per MTok, 1M context, 128K
 * output. Bedrock's global endpoint charges that price and its US
 * cross-region profile 10% more, as for Fable 5.1. OpenRouter lists
 * `anthropic/claude-fable-5.2` at the Anthropic price and its batch variant at
 * half. Copilot bills by premium requests; dx records Anthropic's token price
 * for it like every other Copilot Claude model.
 */
const FABLE_5_2 = cost(8, 40, 0.2, 10);
const FABLE_5_2_US = cost(8.8, 44, 0.22, 11);
const FABLE_5_2_BATCH = cost(4, 20, 0.1, 5);

const SUCCESSORS: ReadonlyArray<Successor> = [
  {
    provider: "anthropic",
    predecessor: "claude-fable-5-1",
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    cost: FABLE_5_2,
  },
  {
    provider: "cloudflare-ai-gateway",
    predecessor: "claude-fable-5-1",
    id: "claude-fable-5-2",
    name: "Claude Fable 5.2",
    cost: FABLE_5_2,
  },
  {
    provider: "amazon-bedrock",
    predecessor: "anthropic.claude-fable-5-1",
    id: "anthropic.claude-fable-5-2",
    name: "Claude Fable 5.2",
    cost: FABLE_5_2,
  },
  {
    provider: "amazon-bedrock",
    predecessor: "global.anthropic.claude-fable-5-1",
    id: "global.anthropic.claude-fable-5-2",
    name: "Claude Fable 5.2 (Global)",
    cost: FABLE_5_2,
  },
  {
    provider: "amazon-bedrock",
    predecessor: "us.anthropic.claude-fable-5-1",
    id: "us.anthropic.claude-fable-5-2",
    name: "Claude Fable 5.2 (US)",
    cost: FABLE_5_2_US,
  },
  {
    provider: "openrouter",
    predecessor: "anthropic/claude-fable-5.1",
    id: "anthropic/claude-fable-5.2",
    name: "Anthropic: Claude Fable 5.2",
    cost: FABLE_5_2,
  },
  {
    provider: "openrouter",
    predecessor: "anthropic/claude-fable-5.1:batch",
    id: "anthropic/claude-fable-5.2:batch",
    name: "Anthropic: Claude Fable 5.2 (batch)",
    cost: FABLE_5_2_BATCH,
  },
  {
    provider: "github-copilot",
    predecessor: "claude-fable-5.1",
    id: "claude-fable-5.2",
    name: "Claude Fable 5.2",
    cost: FABLE_5_2,
  },
];

/**
 * pi's models for a pi provider id plus the successors pi does not list yet,
 * each placed just before its predecessor. pi's own entry wins once an
 * upgrade lists the same id.
 */
export const builtinModelsWithSuccessors = (
  piProviderId: string,
): Array<Model<Api>> => {
  const models = getBuiltinModels(piProviderId as BuiltinProviderId);
  const pending = SUCCESSORS.filter(
    ({ provider, id }) =>
      provider === piProviderId && !models.some((model) => model.id === id),
  );
  return models.flatMap((model) => [
    ...pending
      .filter(({ predecessor }) => predecessor === model.id)
      .map(({ id, name, cost: price }) => ({
        ...model,
        id,
        name,
        cost: price,
      })),
    model,
  ]);
};
