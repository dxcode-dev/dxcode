import { Schema } from "effect";

/**
 * The Speech plugin's API (`speech.transcribe`). Composer dictation sends one
 * canonical WAV (16 kHz, mono, 16-bit PCM) and polls for its transcript.
 * Every speech provider implements the same two functions, so swapping the
 * provider never changes the dictation routes or the composer.
 */
export const SpeechTranscriptionStatus = Schema.Union([
  Schema.Literal("processing"),
  Schema.Literal("failed"),
  Schema.Struct({ text: Schema.NonEmptyString }),
]);

export type SpeechTranscriptionStatus = typeof SpeechTranscriptionStatus.Type;

export class SpeechProviderError extends Schema.TaggedError<SpeechProviderError>()(
  "SpeechProviderError",
  { reason: Schema.String },
) {}

/**
 * Persistence checkpoints a provider calls while it starts a job, so the
 * caller can record the provider job ID and stop work for a job canceled
 * meanwhile. Either returning false cancels the start.
 */
export interface SpeechJobCheckpoints {
  readonly created: (jobId: string) => Promise<boolean>;
  readonly active: (jobId: string) => Promise<boolean>;
}

export interface SpeechProvider {
  /** Starts transcribing the WAV and returns the provider job ID. */
  readonly startTranscription: (
    wav: Uint8Array,
    checkpoints: SpeechJobCheckpoints,
    signal?: AbortSignal,
  ) => Promise<string>;
  readonly readTranscription: (
    jobId: string,
    signal?: AbortSignal,
  ) => Promise<SpeechTranscriptionStatus>;
}
