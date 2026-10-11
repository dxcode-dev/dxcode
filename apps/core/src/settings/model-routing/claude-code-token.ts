/**
 * Claude Pro/Max connections store the long-lived OAuth token that
 * `claude setup-token` prints. Anthropic answers its model list for that
 * token without spending plan usage, so it proves the token before saving
 * and on every access check.
 */
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";

export const CLAUDE_CODE_TOKEN_PREFIX = "sk-ant-oat";

export type ClaudeCodeTokenCheck = "valid" | "rejected" | "unreachable";

export const claudeCodeTokenHeaders = (token: string) => ({
  authorization: `Bearer ${token}`,
  "anthropic-beta": "oauth-2025-04-20",
  "anthropic-version": "2023-06-01",
});

/** Replaced in tests; production calls Anthropic. */
export const claudeCodeTokenFetch: { current: typeof fetch } = {
  current: (input, init) => fetch(input, init),
};

export const checkClaudeCodeToken = async (
  token: string,
): Promise<ClaudeCodeTokenCheck> => {
  const response = await claudeCodeTokenFetch
    .current(MODELS_URL, {
      method: "GET",
      headers: claudeCodeTokenHeaders(token),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => undefined);
  if (response === undefined) return "unreachable";
  await response.body?.cancel();
  if (response.status === 401 || response.status === 403) return "rejected";
  return response.ok ? "valid" : "unreachable";
};

export const claudeCodeTokenHealth = (check: ClaudeCodeTokenCheck) =>
  check === "valid"
    ? ({ state: "healthy", code: "CONNECTED" } as const)
    : check === "rejected"
      ? ({ state: "unhealthy", code: "AUTH_REJECTED" } as const)
      : ({ state: "unhealthy", code: "NETWORK_ERROR" } as const);
