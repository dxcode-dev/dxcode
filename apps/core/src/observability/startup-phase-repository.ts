import type { PersistenceUnavailable, ThreadId } from "@dx/domain";
import { Context, type DateTime, type Effect, Schema } from "effect";
import type {
  StartupPhaseName,
  StartupPhaseObservation,
  StartupPhaseOutcome,
  StartupTraceCorrelation,
} from "./startup-phase.js";
import type { StartupSloSample } from "./startup-slo.js";

export const MAX_STARTUP_SLO_SAMPLES = 10_000;

export const StartupSloMetric = Schema.Literals([
  "thread_create",
  "submission_admission",
  "scheduling",
  "source_backed_model_request",
  "source_backed_first_token",
  "context_discovery",
  "terminal_warm",
  "terminal_wake",
]);
export type StartupSloMetric = typeof StartupSloMetric.Type;

export const StartupSloSampleQuery = Schema.Struct({
  metric: StartupSloMetric,
  since: Schema.DateTimeUtcFromString,
  limit: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: MAX_STARTUP_SLO_SAMPLES }),
  ),
});
export type StartupSloSampleQuery = typeof StartupSloSampleQuery.Type;

export interface StartupPhaseEvidenceObservation {
  readonly phase: StartupPhaseName;
  readonly ordinal: number;
  readonly occurredAt: DateTime.Utc;
  readonly expiresAt: DateTime.Utc;
  readonly outcome: StartupPhaseOutcome;
  readonly durationMs: number;
  readonly operationCount: number | null;
}

export interface StartupPhaseEvidence {
  readonly correlation: StartupTraceCorrelation;
  readonly observations: ReadonlyArray<StartupPhaseEvidenceObservation>;
}

export interface StartupSubmissionCorrelation {
  readonly correlation: Extract<
    StartupTraceCorrelation,
    { readonly journey: "submission" }
  >;
  readonly startedAt: DateTime.Utc;
}

export type StartupPhaseRepositoryError =
  | PersistenceUnavailable
  | Schema.SchemaError;

export interface StartupPhaseRepositoryShape {
  readonly record: (
    observations: ReadonlyArray<StartupPhaseObservation>,
  ) => Effect.Effect<void, StartupPhaseRepositoryError>;
  readonly evidence: (
    correlation: StartupTraceCorrelation,
  ) => Effect.Effect<StartupPhaseEvidence, StartupPhaseRepositoryError>;
  readonly submissionCorrelation: (
    threadId: ThreadId,
    submissionId: string,
  ) => Effect.Effect<
    StartupSubmissionCorrelation | null,
    StartupPhaseRepositoryError
  >;
  readonly sloSamples: (
    query: StartupSloSampleQuery,
  ) => Effect.Effect<
    ReadonlyArray<StartupSloSample>,
    StartupPhaseRepositoryError
  >;
}

export class StartupPhaseRepository extends Context.Service<
  StartupPhaseRepository,
  StartupPhaseRepositoryShape
>()("@dx/core/observability/StartupPhaseRepository") {}
