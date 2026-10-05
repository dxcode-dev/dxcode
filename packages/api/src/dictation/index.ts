import { Schema } from "effect";

export const DICTATION_MAX_SECONDS = 900;
export const DICTATION_SAMPLE_RATE = 16_000;
export const DICTATION_MAX_SAMPLES = 14_400_000;
export const DICTATION_MAX_BYTES = 28_800_044;

export const DictationJobSchema = Schema.Union([
  Schema.Struct({ id: Schema.String, state: Schema.Literal("processing") }),
  Schema.Struct({
    id: Schema.String,
    state: Schema.Literal("completed"),
    text: Schema.String,
  }),
  Schema.Struct({
    id: Schema.String,
    state: Schema.Literal("failed"),
    error: Schema.String,
  }),
]);
export type DictationJob = typeof DictationJobSchema.Type;

export const DictationErrorSchema = Schema.Struct({ error: Schema.String });

/**
 * Speech is not installed, is disabled for this user, or resolves no
 * provider. Dictation fails closed; the composer hides its microphone.
 */
export const DictationUnavailableSchema = Schema.Struct({
  code: Schema.Literal("DICTATION_UNAVAILABLE"),
  error: Schema.Literal("Dictation is not available."),
});
export type DictationUnavailable = typeof DictationUnavailableSchema.Type;
export type DictationError = typeof DictationErrorSchema.Type;
