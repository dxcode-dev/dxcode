import { Effect, Schema } from "effect";

const Verification = Schema.Struct({
  success: Schema.Boolean,
  hostname: Schema.optional(Schema.String),
  action: Schema.optional(Schema.String),
  metadata: Schema.optional(
    Schema.Struct({ result_with_testing_key: Schema.optional(Schema.Boolean) }),
  ),
});

/**
 * Cloudflare's published always-pass secret, which branch previews may bind
 * (DX_DEPLOYMENT_TURNSTILE_TEST_KEYS). Its answers name example.com and carry
 * no action, so they are accepted only for this exact secret.
 */
const TEST_SECRET = "1x0000000000000000000000000000000AA";

export class TurnstileError extends Schema.TaggedError<TurnstileError>()(
  "TurnstileError",
  { message: Schema.String },
) {}

/** Verifies a single-use token before admission or email delivery. */
export const verifyTurnstile = (input: {
  readonly token: string | null;
  readonly secret: string | undefined;
  readonly hostname: string;
}) =>
  Effect.gen(function* () {
    if (!input.secret?.trim())
      return yield* new TurnstileError({
        message: "Sign-in protection is not configured.",
      });
    if (!input.token || input.token.length > 2048)
      return yield* new TurnstileError({
        message: "Please complete the security check and try again.",
      });
    const response = yield* Effect.tryPromise({
      try: () =>
        fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ secret: input.secret, response: input.token }),
          signal: AbortSignal.timeout(10_000),
        }),
      catch: () =>
        new TurnstileError({
          message: "Security check unavailable. Please try again.",
        }),
    });
    const result = yield* Effect.tryPromise({
      try: async () => {
        if (!response.ok) throw new Error();
        return Schema.decodeUnknownPromise(Verification)(await response.json());
      },
      catch: () =>
        new TurnstileError({
          message: "Security check unavailable. Please try again.",
        }),
    });
    const testingKey =
      input.secret === TEST_SECRET &&
      result.metadata?.result_with_testing_key === true;
    if (
      !result.success ||
      (!testingKey &&
        (result.hostname !== input.hostname || result.action !== "dx-access"))
    ) {
      return yield* new TurnstileError({
        message: "Security check failed. Please try again.",
      });
    }
  });
