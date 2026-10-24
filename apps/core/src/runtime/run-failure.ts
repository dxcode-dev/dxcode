/**
 * The one classification of an agent run's failures, shared by the model
 * transports, the Claude Code adapter, the workspace drivers, and Flue's
 * retry policy (see `wiki/runtime-architecture.md#failures-and-retries`).
 *
 * - `account`: the user's provider account or plan refuses the request
 *   (budget, quota, plan limit, credentials, entitlement). Retrying cannot
 *   help; the user must act, so the text says what to do.
 * - `transient`: the provider or network failed this attempt (5xx, rate
 *   limit, dropped stream). Retried with backoff.
 * - `platform`: Cloudflare reset or lost an object, storage, or container
 *   under the run. Retried with backoff on fresh handles.
 * - `internal`: a dx bug, or a request the provider rejects as invalid. The
 *   same request fails again, so it is not retried.
 */
export type RunFailureClass = "account" | "transient" | "platform" | "internal";

export interface RunFailure {
  readonly class: RunFailureClass;
  /** Stable code for logs and the client. */
  readonly code: string;
  /** Plain text for the person; never raw provider JSON. */
  readonly message: string;
  readonly retryable: boolean;
  readonly status?: number;
}

export interface RunFailureInput {
  readonly message: string;
  readonly status?: number;
}

/**
 * Waits between attempts of one failed step: about 6.5 minutes in all, long
 * enough to ride out the multi-minute Durable Object storage outages seen in
 * production without the person noticing.
 */
export const RUN_RETRY_DELAYS_MS: ReadonlyArray<number> = [
  1_000, 2_000, 4_000, 8_000, 15_000, 30_000, 60_000, 60_000, 60_000, 60_000,
  90_000,
];

/**
 * The wait before retry `attempt` (1-based), or undefined once the schedule
 * is spent. `random` supplies jitter in [0, 1): delays fall in [75%, 100%].
 */
export const runRetryDelayMs = (
  attempt: number,
  random: () => number = Math.random,
  retryAfterMs?: number,
): number | undefined => {
  const base = RUN_RETRY_DELAYS_MS[attempt - 1];
  if (base === undefined) return undefined;
  const jittered = Math.round(base * (0.75 + 0.25 * random()));
  return Math.max(jittered, retryAfterMs ?? 0);
};

const ACCOUNT_RULES: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly code: string;
  readonly message?: string;
}> = [
  {
    pattern: /budget_exceeded|budget has been exceeded/i,
    code: "PROVIDER_BUDGET_EXCEEDED",
    message:
      "The budget on this model connection is used up. Raise its budget or choose another model, then retry.",
  },
  {
    pattern:
      /insufficient_quota|exceeded your current quota|credit balance is too low/i,
    code: "PROVIDER_QUOTA_EXCEEDED",
    message:
      "The model provider account has no credit or quota left. Add credit or choose another model, then retry.",
  },
  { pattern: /plan limit reached/i, code: "PLAN_LIMIT_REACHED" },
  {
    pattern: /SUBSCRIPTION_NOT_CONNECTED|MODEL_NOT_ENTITLED|MODEL_DISABLED/,
    code: "SUBSCRIPTION_MODEL_UNAVAILABLE",
    message:
      "Your subscription does not currently offer this model. Check the connection in Settings, or choose another model.",
  },
  {
    pattern: /request not allowed/i,
    code: "PROVIDER_REQUEST_NOT_ALLOWED",
    message:
      "The model provider refused requests from this workspace's location. Retry in a new Thread, or choose another model.",
  },
  {
    pattern:
      /failed to authenticate|authentication_error|invalid_api_key|incorrect api key|CREDENTIAL_UNAVAILABLE|COPILOT_UNAUTHORIZED|COPILOT_FORBIDDEN/i,
    code: "PROVIDER_AUTHENTICATION_FAILED",
    message:
      "The model provider rejected this connection's credentials. Reconnect it in Settings, then retry.",
  },
];

const PLATFORM_PATTERN =
  /durable object|blockConcurrencyWhile|internal error; reference =|could not be read for a minute|container (?:is not running|start timed out|was reset)|workspace (?:start|open) timed out/i;

const TRANSIENT_PATTERN =
  /overloaded|rate.?limit|too many requests|service.?unavailable|server.?error|network|connection (?:lost|reset|refused|closed|error)|socket hang up|fetch failed|timed? ?out|mid-response|ECONNRESET|\(empty_model_response\)|\(retryable_interruption\)|stream (?:ended|terminated)/i;

const statusOf = (input: RunFailureInput) => {
  if (input.status !== undefined) return input.status;
  const text = input.message;
  const found =
    /"upstreamStatus"\s*:\s*(\d{3})/.exec(text) ??
    /api error \((\d{3})\)/i.exec(text) ??
    /api error: (\d{3})\b/i.exec(text) ??
    /error code: (\d{3})\b/i.exec(text) ??
    /^(?:\w+\(sub_[^)]*\) failed: )?(\d{3})\b/.exec(text);
  return found?.[1] === undefined ? undefined : Number(found[1]);
};

const plainText = (message: string) =>
  message.replace(/^\w+\(sub_[^)]*\) failed: /, "");

const failure = (
  failureClass: RunFailureClass,
  code: string,
  message: string,
  status: number | undefined,
): RunFailure => ({
  class: failureClass,
  code,
  message,
  retryable: failureClass === "transient" || failureClass === "platform",
  ...(status === undefined ? {} : { status }),
});

/**
 * Errors cross Flue as text (`errorMessage`), so a layer that already knows
 * the class stamps it into the text; `classifyRunFailure` reads the stamp
 * before any pattern.
 */
const MARKER =
  /\(dx_failure:(account|transient|platform|internal):([A-Z0-9_]+)\)/;

export const markRunFailure = (failure: RunFailure) =>
  `${failure.message} (dx_failure:${failure.class}:${failure.code})`;

/** The text without its stamp, for the person. */
export const runFailureText = (message: string) =>
  message.replace(MARKER, "").trim();

export const classifyRunFailure = (input: RunFailureInput): RunFailure => {
  const marked = MARKER.exec(input.message);
  if (marked?.[1] !== undefined && marked[2] !== undefined)
    return failure(
      marked[1] as RunFailureClass,
      marked[2],
      runFailureText(plainText(input.message)),
      input.status,
    );
  const status = statusOf(input);
  const text = plainText(input.message);
  for (const rule of ACCOUNT_RULES)
    if (rule.pattern.test(text))
      return failure("account", rule.code, rule.message ?? text, status);
  if (PLATFORM_PATTERN.test(text))
    return failure(
      "platform",
      "PLATFORM_INTERRUPTED",
      "The workspace platform interrupted this run.",
      status,
    );
  if (status === 401 || status === 403)
    return failure(
      "account",
      "PROVIDER_AUTHENTICATION_FAILED",
      "The model provider rejected this connection's credentials. Reconnect it in Settings, then retry.",
      status,
    );
  if (status === 402)
    return failure(
      "account",
      "PROVIDER_QUOTA_EXCEEDED",
      "The model provider account has no credit or quota left. Add credit or choose another model, then retry.",
      status,
    );
  if (
    status !== undefined &&
    (status === 408 ||
      status === 409 ||
      status === 425 ||
      status === 429 ||
      status >= 500)
  )
    return failure(
      "transient",
      "PROVIDER_UNAVAILABLE",
      "The model provider is temporarily unavailable.",
      status,
    );
  if (status !== undefined && status >= 400)
    return failure(
      "internal",
      "PROVIDER_REJECTED_REQUEST",
      `The model provider rejected the request (HTTP ${status}).`,
      status,
    );
  if (TRANSIENT_PATTERN.test(text))
    return failure(
      "transient",
      "PROVIDER_UNAVAILABLE",
      "The model provider is temporarily unavailable.",
      status,
    );
  return failure("internal", "INTERNAL", text, status);
};
