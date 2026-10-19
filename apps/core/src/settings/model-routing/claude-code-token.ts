import type { ClaudePlanReading } from "@dx/domain";
import { claudePlanReadingFromHeaders } from "../../claude-code/plan.js";

/**
 * Claude Pro/Max connections store the long-lived OAuth token that
 * `claude setup-token` prints. Anthropic answers its model list for that
 * token without spending plan usage, so it proves the token before saving,
 * and on an access check while the plan is used up.
 */
const MODELS_URL = "https://api.anthropic.com/v1/models?limit=1";
const MESSAGES_URL = "https://api.anthropic.com/v1/messages";

/** Anthropic serves OAuth tokens only to requests that identify as Claude Code. */
export const CLAUDE_CODE_IDENTITY =
  "You are Claude Code, Anthropic's official CLI for Claude.";
/** Titles and plan readings stay cheap whatever model the Thread runs. */
export const CLAUDE_CODE_SMALL_MODEL = "claude-haiku-5-5";

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

/**
 * Proves the token and reads the plan's limits in one call. The token's only
 * scope is `user:inference`, so Anthropic's usage and profile endpoints
 * refuse it, and the model list carries no limits: a one-token Messages call
 * is the cheapest request whose response reports them. A used-up plan
 * answers 429 with the same headers, which is still a valid token.
 */
export const readClaudePlanWithToken = async (
  token: string,
): Promise<{
  readonly check: ClaudeCodeTokenCheck;
  readonly reading?: ClaudePlanReading;
  /** Anthropic's status and error for a refused call; never the token. */
  readonly refusal?: string;
}> => {
  const response = await claudeCodeTokenFetch
    .current(MESSAGES_URL, {
      method: "POST",
      headers: {
        ...claudeCodeTokenHeaders(token),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        model: CLAUDE_CODE_SMALL_MODEL,
        max_tokens: 1,
        system: [{ type: "text", text: CLAUDE_CODE_IDENTITY }],
        messages: [{ role: "user", content: "quota" }],
      }),
      redirect: "manual",
      signal: AbortSignal.timeout(15_000),
    })
    .catch(() => undefined);
  if (response === undefined) return { check: "unreachable" };
  const refusal = response.ok
    ? undefined
    : await response
        .json()
        .then((body) => {
          const error = (
            body as { error?: { type?: unknown; message?: unknown } }
          ).error;
          return `HTTP_${response.status} ${String(error?.type ?? "")}: ${String(error?.message ?? "").slice(0, 300)}`;
        })
        .catch(() => `HTTP_${response.status}`)
        // The Cloudflare location Anthropic saw the call from, such as HKG.
        .then(
          (text) =>
            `${text} (colo ${response.headers.get("cf-ray")?.split("-").pop() ?? "unknown"})`,
        );
  await response.body?.cancel().catch(() => undefined);
  const reading = claudePlanReadingFromHeaders(response.headers);
  const check: ClaudeCodeTokenCheck =
    response.status === 401 || response.status === 403
      ? "rejected"
      : response.ok || response.status === 429
        ? "valid"
        : "unreachable";
  return {
    check,
    ...(reading === undefined ? {} : { reading }),
    ...(refusal === undefined ? {} : { refusal }),
  };
};
