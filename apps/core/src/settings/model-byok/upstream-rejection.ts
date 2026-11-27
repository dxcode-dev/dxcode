import {
  type AssistantMessage,
  isContextOverflow,
} from "@earendil-works/pi-ai";
import {
  classifyRunFailure,
  type RunFailure,
} from "../../runtime/run-failure.js";

/**
 * How dx reads a provider's non-2xx answer, apart from the coordinator
 * Durable Object that receives it, so every transport and test shares it.
 */

const PROVIDER_DETAIL_LIMIT = 500;

/** The provider's own error sentence, never its JSON envelope. */
const providerDetail = (body: string) => {
  const text = body.trim();
  if (text === "" || text.startsWith("<")) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return text.slice(0, PROVIDER_DETAIL_LIMIT);
  }
  const record = (value: unknown) =>
    typeof value === "object" && value !== null
      ? (value as Record<string, unknown>)
      : {};
  const error = record(parsed).error;
  return [
    record(error).message,
    record(parsed).message,
    error,
    record(parsed).detail,
  ]
    .find(
      (value): value is string =>
        typeof value === "string" && value.trim() !== "",
    )
    ?.trim()
    .slice(0, PROVIDER_DETAIL_LIMIT);
};

/**
 * Classifies a non-2xx provider answer from its status and redacted body.
 * The message is plain text; a request the provider rejects keeps the
 * provider's sentence so Flue still recognizes a context overflow.
 */
export const classifyUpstreamRejection = (
  status: number,
  body: string,
): RunFailure => {
  const failure = classifyRunFailure({ status, message: body });
  const detail = providerDetail(body);
  if (failure.class === "internal") {
    const message = `The model provider rejected the request (HTTP ${status})${detail === undefined ? "." : `: ${detail}`}`;
    const overflow = (errorMessage: string) =>
      isContextOverflow({
        stopReason: "error",
        errorMessage,
      } as AssistantMessage);
    return {
      ...failure,
      message:
        overflow(`${status} ${body}`) && !overflow(message)
          ? `${message} Context length exceeded.`
          : message,
    };
  }
  // A rule without its own text echoes the input.
  return failure.message === body
    ? {
        ...failure,
        message:
          detail ?? `The model provider refused the request (HTTP ${status}).`,
      }
    : failure;
};
