import type { ObservedModel } from "./live-catalog.js";

/**
 * Claude Pro/Max connections store the long-lived OAuth token that
 * `claude setup-token` prints. Core sends it to Anthropic only to read the
 * model list, which tells whether the token is valid and which models the
 * plan serves, and spends no plan usage. Everything else on the plan,
 * including its limits, comes from the Claude Code binary in an Orb.
 */
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1000";

/** Titles stay cheap whatever model the Thread runs. */
export const CLAUDE_CODE_SMALL_MODEL = "claude-haiku-5-5";

export const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";

export type ClaudeCodeTokenCheck = "valid" | "rejected" | "unreachable";

const positive = (value: unknown) =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : undefined;

const supported = (capabilities: unknown, name: string) => {
  const capability =
    typeof capabilities === "object" && capabilities !== null
      ? (capabilities as Record<string, unknown>)[name]
      : undefined;
  return typeof capability === "object" && capability !== null
    ? (capability as Record<string, unknown>).supported === true
    : undefined;
};

/** Anthropic's `/v1/models` list as the models a Claude plan serves, newest first. */
export const parseClaudeCodeModels = (
  raw: unknown,
): ReadonlyArray<ObservedModel> => {
  const data =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>).data
      : undefined;
  if (!Array.isArray(data)) return [];
  return data.flatMap((item): ObservedModel[] => {
    if (typeof item !== "object" || item === null) return [];
    const model = item as Record<string, unknown>;
    if (typeof model.id !== "string" || !model.id.startsWith("claude-"))
      return [];
    const contextWindow = positive(model.max_input_tokens);
    const maxTokens = positive(model.max_tokens);
    const vision = supported(model.capabilities, "image_input");
    const reasoning = supported(model.capabilities, "thinking");
    return [
      {
        id: model.id,
        ...(typeof model.display_name === "string" && model.display_name
          ? { name: model.display_name }
          : {}),
        ...(contextWindow === undefined ? {} : { contextWindow }),
        ...(maxTokens === undefined ? {} : { maxTokens }),
        ...(vision === undefined ? {} : { vision }),
        ...(reasoning === undefined ? {} : { reasoning }),
      },
    ];
  });
};

/**
 * Asks Anthropic for the plan's model list: whether the token is valid,
 * and, when it is, the models the plan serves.
 */
export const listClaudeCodeModels = async (
  token: string,
  fetcher: typeof fetch = fetch,
): Promise<
  | { readonly check: "valid"; readonly models: ReadonlyArray<ObservedModel> }
  | { readonly check: "rejected" | "unreachable" }
> => {
  const response = await fetcher(MODELS_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (response === undefined) return { check: "unreachable" };
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel();
    return { check: "rejected" };
  }
  if (!response.ok) {
    await response.body?.cancel();
    return { check: "unreachable" };
  }
  const models = parseClaudeCodeModels(
    await response.json().catch(() => undefined),
  );
  return { check: "valid", models };
};

export const checkClaudeCodeToken = async (
  token: string,
): Promise<ClaudeCodeTokenCheck> => (await listClaudeCodeModels(token)).check;

/**
 * Whether a credential is a Claude plan token. Only a Claude Pro/Max
 * connection may hold one: another connection would send it from Core, and
 * the Anthropic SDK answers such a token by claiming to be Claude Code.
 */
export const isClaudePlanToken = (value: string) =>
  value.includes(CLAUDE_CODE_TOKEN_PREFIX);
