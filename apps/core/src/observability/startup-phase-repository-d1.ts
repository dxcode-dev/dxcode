import { PersistenceUnavailable } from "@dx/domain";
import { DateTime, Effect, Layer, Schema } from "effect";
import {
  StartupJourney,
  StartupPhaseName,
  StartupPhaseObservation,
  StartupPhaseOutcome,
  StartupRequestId,
  StartupTraceCorrelation,
  startupPhaseOrdinal,
} from "./startup-phase.js";
import {
  type StartupPhaseEvidenceObservation,
  StartupPhaseRepository,
  type StartupSloMetric,
} from "./startup-phase-repository.js";
import { StartupSloSample } from "./startup-slo.js";

type EncodedObservation = typeof StartupPhaseObservation.Encoded;

const EvidenceRow = Schema.Struct({
  journey: StartupJourney,
  request_id: StartupRequestId,
  thread_id: Schema.String,
  submission_id: Schema.String,
  phase: StartupPhaseName,
  ordinal: Schema.Int,
  occurred_at: Schema.DateTimeUtcFromString,
  expires_at: Schema.DateTimeUtcFromString,
  outcome: StartupPhaseOutcome,
  duration_ms: Schema.Int,
  operation_count: Schema.NullOr(Schema.Int),
});

const SloSampleRow = Schema.Struct({
  outcome: StartupPhaseOutcome,
  duration_ms: Schema.Int,
  baseline_outcome: Schema.NullOr(StartupPhaseOutcome),
  baseline_occurred_at: Schema.NullOr(Schema.DateTimeUtcFromString),
  completion_occurred_at: Schema.NullOr(Schema.DateTimeUtcFromString),
});

const SubmissionCorrelationRow = Schema.Struct({
  request_id: StartupRequestId,
  occurred_at: Schema.DateTimeUtcFromString,
});

const unavailable = (operation: string, cause: unknown) =>
  PersistenceUnavailable.new({ operation }, cause);

const run = <Value>(operation: string, attempt: () => Promise<Value>) =>
  Effect.tryPromise({
    try: attempt,
    catch: (cause) => unavailable(operation, cause),
  });

const submissionId = (
  correlation: EncodedObservation["correlation"],
): string => {
  switch (correlation.journey) {
    case "submission":
    case "submission_daemon_activation":
      return correlation.submissionId;
    default:
      return "";
  }
};

const encodedInsert = (db: D1Database, observation: EncodedObservation) =>
  db
    .prepare(
      `INSERT INTO startup_phase_event (
         journey, request_id, thread_id, submission_id, phase, ordinal,
         occurred_at, expires_at, outcome, duration_ms, operation_count
       ) VALUES (?, ?, ?, ?, ?, ?, ?,
         strftime('%Y-%m-%dT%H:%M:%fZ', ?, '+30 days'), ?, ?, ?
       )
       ON CONFLICT (journey, request_id, thread_id, submission_id, phase)
       DO NOTHING`,
    )
    .bind(
      observation.correlation.journey,
      observation.correlation.requestId,
      observation.correlation.threadId,
      submissionId(observation.correlation),
      observation.phase,
      startupPhaseOrdinal(observation),
      observation.occurredAt,
      observation.occurredAt,
      observation.outcome,
      observation.durationMs,
      "operationCount" in observation ? observation.operationCount : null,
    );

const correlationFrom = (row: typeof EvidenceRow.Type) =>
  Schema.decodeUnknownEffect(StartupTraceCorrelation)(
    row.journey === "submission" ||
      row.journey === "submission_daemon_activation"
      ? {
          journey: row.journey,
          requestId: row.request_id,
          threadId: row.thread_id,
          submissionId: row.submission_id,
        }
      : {
          journey: row.journey,
          requestId: row.request_id,
          threadId: row.thread_id,
        },
  );

const evidenceObservationFrom = (
  row: typeof EvidenceRow.Type,
): StartupPhaseEvidenceObservation => ({
  phase: row.phase,
  ordinal: row.ordinal,
  occurredAt: row.occurred_at,
  expiresAt: row.expires_at,
  outcome: row.outcome,
  durationMs: row.duration_ms,
  operationCount: row.operation_count,
});

const metricSelection = (
  metric: StartupSloMetric,
): {
  readonly journey: "thread_create" | "submission" | "terminal";
  readonly phase: string;
  readonly openingPhase?: "workspace_starting" | "workspace_waking";
  readonly baselinePhase?: "source_activated";
} => {
  switch (metric) {
    case "thread_create":
      return { journey: "thread_create", phase: "response_ready" };
    case "submission_admission":
      return { journey: "submission", phase: "submission_accepted" };
    case "scheduling":
      return { journey: "submission", phase: "flue_running" };
    case "source_backed_model_request":
      return {
        journey: "submission",
        phase: "model_requested",
        baselinePhase: "source_activated",
      };
    case "source_backed_first_token":
      return {
        journey: "submission",
        phase: "model_first_token",
        baselinePhase: "source_activated",
      };
    case "context_discovery":
      return { journey: "submission", phase: "context_discovered" };
    case "terminal_warm":
      return {
        journey: "terminal",
        phase: "terminal_ready",
        openingPhase: "workspace_starting",
      };
    case "terminal_wake":
      return {
        journey: "terminal",
        phase: "terminal_ready",
        openingPhase: "workspace_waking",
      };
  }
};

export const StartupPhaseRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    StartupPhaseRepository,
    StartupPhaseRepository.of({
      record: (observations) =>
        Effect.gen(function* () {
          if (observations.length === 0) return;
          const encoded = yield* Schema.encodeEffect(
            Schema.Array(StartupPhaseObservation),
          )(observations);
          yield* run("startup-phase.record", () =>
            db.batch(encoded.map((item) => encodedInsert(db, item))),
          );
        }),
      evidence: (correlation) =>
        Effect.gen(function* () {
          const result = yield* run("startup-phase.evidence", () =>
            db
              .prepare(
                `SELECT journey, request_id, thread_id, submission_id, phase,
                        ordinal, occurred_at, expires_at, outcome, duration_ms,
                        operation_count
                   FROM startup_phase_event
                  WHERE journey = ? AND request_id = ? AND thread_id = ?
                    AND submission_id = ?
                  ORDER BY ordinal`,
              )
              .bind(
                correlation.journey,
                correlation.requestId,
                correlation.threadId,
                submissionId(correlation),
              )
              .all(),
          );
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(EvidenceRow),
          )(result.results);
          const storedCorrelation = rows[0];
          return {
            correlation:
              storedCorrelation === undefined
                ? correlation
                : yield* correlationFrom(storedCorrelation),
            observations: rows.map(evidenceObservationFrom),
          };
        }),
      submissionCorrelation: (threadId, submissionId) =>
        Effect.gen(function* () {
          const result = yield* run(
            "startup-phase.submission-correlation",
            () =>
              db
                .prepare(
                  `SELECT accepted.request_id, opening.occurred_at
                   FROM startup_phase_event AS accepted
                   JOIN startup_phase_event AS opening
                     ON opening.journey = accepted.journey
                    AND opening.request_id = accepted.request_id
                    AND opening.thread_id = accepted.thread_id
                    AND opening.submission_id = accepted.submission_id
                    AND opening.phase = 'request_admitted'
                  WHERE accepted.journey = 'submission'
                    AND accepted.thread_id = ?
                    AND accepted.submission_id = ?
                    AND accepted.phase = 'submission_accepted'
                  ORDER BY accepted.occurred_at
                  LIMIT 2`,
                )
                .bind(threadId, submissionId)
                .all(),
          );
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(SubmissionCorrelationRow),
          )(result.results);
          if (rows.length === 0) return null;
          if (rows.length > 1)
            return yield* unavailable(
              "startup-phase.submission-correlation",
              "ambiguous correlation",
            );
          const row = rows[0];
          const correlation = yield* Schema.decodeUnknownEffect(
            StartupTraceCorrelation,
          )({
            journey: "submission",
            requestId: row.request_id,
            threadId,
            submissionId,
          });
          if (correlation.journey !== "submission")
            return yield* unavailable(
              "startup-phase.submission-correlation",
              "invalid correlation",
            );
          return {
            correlation,
            startedAt: row.occurred_at,
          };
        }),
      sloSamples: (query) =>
        Effect.gen(function* () {
          const selection = metricSelection(query.metric);
          const baselineJoin =
            selection.baselinePhase === undefined
              ? ""
              : `LEFT JOIN startup_phase_event AS baseline
                     ON baseline.journey = eligible.journey
                    AND baseline.request_id = eligible.request_id
                    AND baseline.thread_id = eligible.thread_id
                    AND baseline.submission_id = eligible.submission_id
                    AND baseline.phase = '${selection.baselinePhase}'`;
          const baselineSelect =
            selection.baselinePhase === undefined
              ? `NULL AS baseline_outcome,
                        NULL AS baseline_occurred_at`
              : `baseline.outcome AS baseline_outcome,
                        baseline.occurred_at AS baseline_occurred_at`;
          const result = yield* run("startup-phase.slo-samples", () =>
            db
              .prepare(
                `SELECT COALESCE(target.outcome, terminal.outcome) AS outcome,
                        COALESCE(target.duration_ms, terminal.duration_ms) AS duration_ms,
                        ${baselineSelect},
                        COALESCE(target.occurred_at, terminal.occurred_at)
                          AS completion_occurred_at
                   FROM startup_phase_event AS eligible
                  ${baselineJoin}
                   LEFT JOIN startup_phase_event AS target
                     ON target.journey = eligible.journey
                    AND target.request_id = eligible.request_id
                    AND target.thread_id = eligible.thread_id
                    AND target.submission_id = eligible.submission_id
                    AND target.phase = ?
                   LEFT JOIN startup_phase_event AS terminal
                     ON terminal.journey = eligible.journey
                    AND terminal.request_id = eligible.request_id
                    AND terminal.thread_id = eligible.thread_id
                    AND terminal.submission_id = eligible.submission_id
                    AND terminal.outcome = 'failed'
                  WHERE eligible.journey = ? AND eligible.phase = ?
                    AND eligible.occurred_at >= ?
                    AND (target.phase IS NOT NULL OR terminal.phase IS NOT NULL)
                  ORDER BY COALESCE(target.occurred_at, terminal.occurred_at) DESC,
                           eligible.request_id DESC, eligible.thread_id DESC,
                           eligible.submission_id DESC
                  LIMIT ?`,
              )
              .bind(
                selection.phase,
                selection.journey,
                selection.openingPhase ?? "request_admitted",
                DateTime.formatIso(query.since),
                query.limit,
              )
              .all(),
          );
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(SloSampleRow),
          )(result.results);
          const samples = [] as Array<{
            readonly outcome: StartupPhaseOutcome;
            readonly durationMs: number;
          }>;
          for (const row of rows) {
            let durationMs = row.duration_ms;
            if (selection.baselinePhase !== undefined) {
              if (
                row.baseline_outcome === "reached" &&
                (row.baseline_occurred_at === null ||
                  row.completion_occurred_at === null)
              )
                return yield* unavailable(
                  "startup-phase.slo-samples",
                  "missing source-backed SLO timestamp",
                );
              if (
                row.baseline_outcome === "reached" &&
                row.baseline_occurred_at !== null &&
                row.completion_occurred_at !== null
              ) {
                durationMs = Math.max(
                  0,
                  DateTime.toEpochMillis(row.completion_occurred_at) -
                    DateTime.toEpochMillis(row.baseline_occurred_at),
                );
              }
            }
            samples.push({ outcome: row.outcome, durationMs });
          }
          return yield* Schema.decodeUnknownEffect(
            Schema.Array(StartupSloSample),
          )(samples);
        }),
    }),
  );
