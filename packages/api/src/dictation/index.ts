import { DictationVocabulary } from "@dx/domain";
import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";
import { SettingsFieldErrorSchema } from "../settings/field-error.js";

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

/**
 * Live dictation socket: `GET /v1/dictation/:id/stream` upgraded with this
 * subprotocol. The client sends binary frames of canonical PCM (16 kHz mono
 * 16-bit little-endian) while recording, then one `{"type":"finish"}` text
 * frame. The server answers with one `DictationStreamResult` and closes.
 */
export const DICTATION_STREAM_SUBPROTOCOL = "dx.dictation.v1";

export const DictationStreamResultSchema = Schema.Union([
  Schema.Struct({ type: Schema.Literal("completed"), text: Schema.String }),
  Schema.Struct({ type: Schema.Literal("failed"), error: Schema.String }),
]);
export type DictationStreamResult = typeof DictationStreamResultSchema.Type;

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

/**
 * Dictation vocabulary for one scope: `GET` and `PUT`
 * `/v1/settings/personal/dictation-vocabulary` and
 * `/v1/settings/workspaces/:workspaceSlug/dictation-vocabulary`. Dictation
 * uses the person's terms, then their workspace's.
 */
export const DictationVocabularyDataSchema = Schema.Struct({
  scope: Schema.Literals(["personal", "workspace"]),
  terms: DictationVocabulary,
  /** Workspace members who cannot update the workspace read it only. */
  canUpdate: Schema.Boolean,
  updatedAt: Schema.NullOr(Schema.String),
});
export type DictationVocabularyData = typeof DictationVocabularyDataSchema.Type;

/** Terms as typed; the server splits, trims, and de-duplicates them. */
export const UpdateDictationVocabularyRequestSchema = Schema.Struct({
  terms: Schema.Array(Schema.String).check(Schema.isMaxLength(1_000)),
});
export type UpdateDictationVocabularyRequest =
  typeof UpdateDictationVocabularyRequestSchema.Type;

export const DictationVocabularyResponseSchema = successResponse(
  DictationVocabularyDataSchema,
);

export const DictationVocabularyErrorResponseSchema = Schema.Union([
  Schema.Struct({
    status: Schema.Literal("error"),
    data: Schema.Struct({
      code: Schema.Literal("INVALID_DICTATION_VOCABULARY"),
      message: Schema.String,
      requestId: Schema.String,
      fieldErrors: Schema.Array(SettingsFieldErrorSchema),
    }),
  }),
  errorResponse(
    "DICTATION_VOCABULARY_FORBIDDEN",
    "Only workspace admins can change the workspace vocabulary.",
  ),
  errorResponse(
    "DICTATION_VOCABULARY_UNAVAILABLE",
    "Dictation vocabulary is temporarily unavailable.",
  ),
]);
export type DictationVocabularyErrorResponse =
  typeof DictationVocabularyErrorResponseSchema.Type;
