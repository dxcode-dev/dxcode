import { describe, expect, it } from "vitest";
import {
  classifyRunFailure,
  markRunFailure,
  RUN_RETRY_DELAYS_MS,
  runRetryDelayMs,
} from "./run-failure.js";

/**
 * Every message below is verbatim from dx.wheelocity.dev Workers Logs,
 * 2026-10-18..23, except where a case names its source.
 */
describe("classifyRunFailure", () => {
  const account = [
    'OpenAI API error (429): {"message":"Budget has been exceeded! Key=dx (sk-...LHmQ) Current cost: 1000.0, Max budget: 1000.0","type":"budget_exceeded","param":null,"code":"429"}',
    '403 {"code":"SUBSCRIPTION_NOT_CONNECTED"}',
    "Claude plan limit reached (5-hour limit, resets 2026-10-23T15:50Z). Claude Code cannot run on this plan until then.",
    "Failed to authenticate. API Error: 403 Request not allowed",
    'OpenAI API error (401): {"error":{"message":"Incorrect API key provided","type":"invalid_request_error"}}',
    '429 {"type":"error","error":{"type":"rate_limit_error","message":"Your credit balance is too low to access the Anthropic API."}}',
    'OpenAI API error (429): {"error":{"message":"You exceeded your current quota","type":"insufficient_quota","code":"insufficient_quota"}}',
  ];
  it.each(account)("does not retry an account failure: %s", (message) => {
    const failure = classifyRunFailure({ message });
    expect(failure.class).toBe("account");
    expect(failure.retryable).toBe(false);
  });

  const transient = [
    "520 error code: 520",
    '502 {"code":"COPILOT_UPSTREAM_UNAVAILABLE","upstreamStatus":503}',
    'OpenAI API error (503): {"error":{"message":"Service Unavailable"}}',
    '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    'OpenAI API error (429): {"error":{"message":"Rate limit reached for requests","type":"requests","code":"rate_limit_exceeded"}}',
    "API Error: Connection lost mid-response. The response above may be incomplete.",
    "fetch failed",
    "Network connection lost.",
    "Request timed out.",
  ];
  it.each(transient)("retries a transient provider failure: %s", (message) => {
    const failure = classifyRunFailure({ message });
    expect(failure.class).toBe("transient");
    expect(failure.retryable).toBe(true);
  });

  const platform = [
    "Claude Code's run could not be read for a minute: Durable Object storage operation exceeded timeout which caused object to be reset.",
    "Durable Object storage operation exceeded timeout which caused object to be reset.",
    "Internal error in Durable Object storage caused object to be reset; reference = 6n58k1pmk82d1p18s9hgh4r2",
    "Connection closed: this Durable Object instance is no longer active. Reconnect or retry the request.",
    "Durable Object storage is no longer accessible.",
    "A call to blockConcurrencyWhile() in a Durable Object waited for too long. The call was canceled and the Durable Object was reset.",
    "internal error; reference = vt3hobiqtopcolsbtu0u5rff",
    "Durable Object reset because its code was updated.",
  ];
  it.each(platform)("retries a platform failure: %s", (message) => {
    const failure = classifyRunFailure({ message });
    expect(failure.class).toBe("platform");
    expect(failure.retryable).toBe(true);
  });

  it("reads the HTTP status when the text has none", () => {
    expect(classifyRunFailure({ status: 503, message: "upstream" }).class).toBe(
      "transient",
    );
    expect(classifyRunFailure({ status: 402, message: "upstream" }).class).toBe(
      "account",
    );
    expect(classifyRunFailure({ status: 400, message: "bad" }).retryable).toBe(
      false,
    );
  });

  it("does not retry a request the provider rejected as invalid", () => {
    // Copilot answered Opus 5's old thinking format with 400 on 2026-10-21;
    // the same request fails on every retry.
    const failure = classifyRunFailure({
      message: '400 {"code":"COPILOT_UPSTREAM_REJECTED","upstreamStatus":400}',
    });
    expect(failure.retryable).toBe(false);
  });

  it("does not let a 429 inside a budget message read as a rate limit", () => {
    // Flue's pattern list retried this message 4-8 times on 2026-10-23.
    const failure = classifyRunFailure({
      message:
        'direct(sub_ik_8ca2b998) failed: OpenAI API error (429): {"message":"Budget has been exceeded! Max budget: 1000.0","type":"budget_exceeded"}',
    });
    expect(failure.code).toBe("PROVIDER_BUDGET_EXCEEDED");
    expect(failure.retryable).toBe(false);
  });

  it("gives account failures plain text, not raw provider JSON", () => {
    const failure = classifyRunFailure({
      message:
        'OpenAI API error (429): {"message":"Budget has been exceeded! Key=dx (sk-...LHmQ) Current cost: 1000.0, Max budget: 1000.0","type":"budget_exceeded","param":null,"code":"429"}',
    });
    expect(failure.message).not.toContain("{");
    expect(failure.message).toContain("budget");
  });

  it("trusts a stamp from the layer that classified the failure", () => {
    const stamped = markRunFailure({
      class: "platform",
      code: "ORB_OPEN_TIMEOUT",
      message: "The workspace took too long to start.",
      retryable: true,
    });
    const failure = classifyRunFailure({
      message: `direct(sub_ik_1) failed: ${stamped}`,
    });
    expect(failure).toMatchObject({
      class: "platform",
      code: "ORB_OPEN_TIMEOUT",
      retryable: true,
      message: "The workspace took too long to start.",
    });
  });

  it("treats an unknown failure as a dx bug that is not retried", () => {
    const failure = classifyRunFailure({
      message: "Cannot read properties of undefined (reading 'id')",
    });
    expect(failure.class).toBe("internal");
    expect(failure.retryable).toBe(false);
  });
});

describe("runRetryDelayMs", () => {
  it("backs off and gives up after the schedule", () => {
    const delays = RUN_RETRY_DELAYS_MS.map((_, index) =>
      runRetryDelayMs(index + 1, () => 1),
    );
    expect(delays).toEqual([...RUN_RETRY_DELAYS_MS]);
    for (let index = 1; index < delays.length; index += 1)
      expect(delays[index]).toBeGreaterThanOrEqual(delays[index - 1] ?? 0);
    expect(runRetryDelayMs(RUN_RETRY_DELAYS_MS.length + 1)).toBeUndefined();
  });

  it("covers a platform outage of several minutes", () => {
    // Storage on the Orb object failed from 13:21:48 to about 13:24 and from
    // 13:29 to 13:32 on 2026-10-23.
    const total = RUN_RETRY_DELAYS_MS.reduce((sum, delay) => sum + delay, 0);
    expect(total).toBeGreaterThanOrEqual(5 * 60_000);
  });

  it("honors a provider's retry-after when it is longer", () => {
    expect(runRetryDelayMs(1, () => 1, 20_000)).toBe(20_000);
  });
});
