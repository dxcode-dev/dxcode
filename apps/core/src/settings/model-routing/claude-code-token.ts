/**
 * Claude Pro/Max connections store the long-lived OAuth token that
 * `claude setup-token` prints. Core sends it to Anthropic only to ask the
 * model list whether the token is valid when it is saved, which spends no
 * plan usage. Everything else on the plan, including its limits, comes from
 * the Claude Code binary in an Orb.
 */
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

/** Titles stay cheap whatever model the Thread runs. */
export const CLAUDE_CODE_SMALL_MODEL = "claude-haiku-5-5";

export const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";

export type ClaudeCodeTokenCheck = "valid" | "rejected" | "unreachable";

export const checkClaudeCodeToken = async (
  token: string,
): Promise<ClaudeCodeTokenCheck> => {
  const response = await fetch(MODELS_URL, {
    method: "GET",
    headers: {
      authorization: `Bearer ${token}`,
      "anthropic-beta": "oauth-2025-04-20",
      "anthropic-version": "2023-06-01",
    },
    redirect: "manual",
    signal: AbortSignal.timeout(15_000),
  }).catch(() => undefined);
  if (response === undefined) return "unreachable";
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) return "rejected";
  return response.ok ? "valid" : "unreachable";
};

/**
 * Whether a credential is a Claude plan token. Only a Claude Pro/Max
 * connection may hold one: another connection would send it from Core, and
 * the Anthropic SDK answers such a token by claiming to be Claude Code.
 */
export const isClaudePlanToken = (value: string) =>
  value.includes(CLAUDE_CODE_TOKEN_PREFIX);
