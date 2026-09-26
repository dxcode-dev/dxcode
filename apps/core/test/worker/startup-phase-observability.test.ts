import { env } from "cloudflare:test";
import { DateTime, Effect, Schema } from "effect";
import { beforeEach, describe, expect, it } from "vitest";
import {
  StartupPhaseObservation,
  StartupTraceCorrelation,
} from "../../src/observability/startup-phase.js";
import {
  StartupPhaseRepository,
  StartupSloSampleQuery,
} from "../../src/observability/startup-phase-repository.js";
import { StartupPhaseRepositoryD1 } from "../../src/observability/startup-phase-repository-d1.js";
import { purgeStartupPhasesBefore } from "../../src/observability/startup-phase-retention.js";
import {
  evaluateStartupSlo,
  startupSloTargets,
} from "../../src/observability/startup-slo.js";

const threadId = "thr_00000000-0000-4000-8000-000000000231" as const;
const correlation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
  journey: "submission",
  requestId: "request-231",
  threadId,
  submissionId: "submission-231",
});
const accepted = Schema.decodeUnknownSync(StartupPhaseObservation)({
  correlation,
  phase: "submission_accepted",
  occurredAt: "2026-08-28T00:00:00.000Z",
  outcome: "reached",
  durationMs: 42,
});
const admitted = Schema.decodeUnknownSync(StartupPhaseObservation)({
  correlation,
  phase: "request_admitted",
  occurredAt: "2026-08-27T23:59:59.990Z",
  outcome: "reached",
  durationMs: 4,
});

const runStartup = <A, E>(
  effect: Effect.Effect<A, E, StartupPhaseRepository>,
) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(StartupPhaseRepositoryD1(env.DB))),
  );

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO projects (id, owner_user_id, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      "prj_00000000-0000-4000-8000-000000000231",
      "startup-owner",
      "Startup project",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
    ),
    env.DB.prepare(
      "INSERT INTO threads (id, project_id, owner_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)",
    ).bind(
      threadId,
      "prj_00000000-0000-4000-8000-000000000231",
      "startup-owner",
      "2026-08-28T00:00:00.000Z",
      "2026-08-28T00:00:00.000Z",
    ),
  ]);
});

describe("startup phase D1 repository", () => {
  it("records one 30-day phase idempotently and exposes allowlisted read-only evidence", async () => {
    const result = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record([admitted, accepted]);
        yield* repository.record([admitted, accepted]);
        const evidence = yield* repository.evidence(correlation);
        const samples = yield* repository.sloSamples(
          Schema.decodeUnknownSync(StartupSloSampleQuery)({
            metric: "submission_admission",
            since: "2026-08-01T00:00:00.000Z",
            limit: 100,
          }),
        );
        return { evidence, samples };
      }),
    );

    expect(result.evidence.correlation).toEqual(correlation);
    expect(result.evidence.observations).toHaveLength(2);
    expect(result.evidence.observations[1]).toMatchObject({
      phase: "submission_accepted",
      ordinal: 1,
      outcome: "reached",
      durationMs: 42,
      operationCount: null,
    });
    const expiresAt = result.evidence.observations[1]?.expiresAt;
    expect(expiresAt).toBeDefined();
    if (expiresAt === undefined) throw new Error("Missing expiry evidence.");
    expect(DateTime.formatIso(expiresAt)).toBe("2026-09-27T00:00:00.000Z");
    expect(result.samples).toEqual([{ outcome: "reached", durationMs: 42 }]);

    const columns = await env.DB.prepare(
      "SELECT name FROM pragma_table_info('startup_phase_event') ORDER BY cid",
    ).all<{ name: string }>();
    expect(columns.results.map(({ name }) => name)).toEqual([
      "journey",
      "request_id",
      "thread_id",
      "submission_id",
      "phase",
      "ordinal",
      "occurred_at",
      "expires_at",
      "outcome",
      "duration_ms",
      "operation_count",
    ]);
  });

  it("resolves one authoritative admission correlation by Thread and submission", async () => {
    const result = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record([admitted, accepted]);
        return yield* repository.submissionCorrelation(
          correlation.threadId,
          correlation.submissionId,
        );
      }),
    );

    expect(result).toEqual({
      correlation,
      startedAt: admitted.occurredAt,
    });
  });

  it("persists the resident Terminal ownership sequence through readiness", async () => {
    const terminalCorrelation = Schema.decodeUnknownSync(
      StartupTraceCorrelation,
    )({
      journey: "terminal",
      requestId: "request-resident-terminal-310",
      threadId,
    });
    const phases = [
      "request_received",
      "authenticated",
      "thread_authorized",
      "websocket_admitted",
      "durable_object_reached",
      "daemon_ready",
      "resident_open_dispatched",
      "resident_ready",
      "resident_attach_dispatched",
      "resident_replay_started",
      "resident_attachment_ready",
      "terminal_ready",
    ] as const;
    const observations = phases.map((phase, index) =>
      Schema.decodeUnknownSync(StartupPhaseObservation)({
        correlation: terminalCorrelation,
        phase,
        occurredAt: `2026-08-28T00:00:${String(index).padStart(2, "0")}.000Z`,
        outcome: "reached",
        durationMs: index,
      }),
    );

    const evidence = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record(observations);
        return yield* repository.evidence(terminalCorrelation);
      }),
    );

    expect(
      evidence.observations.map(({ phase, ordinal }) => ({ phase, ordinal })),
    ).toEqual([
      { phase: "request_received", ordinal: 0 },
      { phase: "authenticated", ordinal: 1 },
      { phase: "thread_authorized", ordinal: 2 },
      { phase: "websocket_admitted", ordinal: 3 },
      { phase: "durable_object_reached", ordinal: 4 },
      { phase: "daemon_ready", ordinal: 24 },
      { phase: "resident_open_dispatched", ordinal: 25 },
      { phase: "resident_ready", ordinal: 26 },
      { phase: "resident_attach_dispatched", ordinal: 27 },
      { phase: "resident_replay_started", ordinal: 28 },
      { phase: "resident_attachment_ready", ordinal: 29 },
      { phase: "terminal_ready", ordinal: 30 },
    ]);
  });

  it("counts an eligible pre-target failure against the startup SLO", async () => {
    const successfulCorrelation = Schema.decodeUnknownSync(
      StartupTraceCorrelation,
    )({
      ...correlation,
      requestId: "request-context-success-237",
      submissionId: "submission-context-success-237",
    });
    const failedCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)(
      {
        ...correlation,
        requestId: "request-context-failed-237",
        submissionId: "submission-context-failed-237",
      },
    );
    const observations = Schema.decodeUnknownSync(
      Schema.Array(StartupPhaseObservation),
    )([
      {
        correlation: successfulCorrelation,
        phase: "request_admitted",
        occurredAt: "2026-08-28T00:00:00.000Z",
        outcome: "reached",
        durationMs: 1,
      },
      {
        correlation: successfulCorrelation,
        phase: "context_discovered",
        occurredAt: "2026-08-28T00:00:00.010Z",
        outcome: "reached",
        durationMs: 10,
        operationCount: 2,
      },
      {
        correlation: failedCorrelation,
        phase: "request_admitted",
        occurredAt: "2026-08-28T00:00:01.000Z",
        outcome: "reached",
        durationMs: 2,
      },
      {
        correlation: failedCorrelation,
        phase: "flue_running",
        occurredAt: "2026-08-28T00:00:01.003Z",
        outcome: "reached",
        durationMs: 3,
      },
      {
        correlation: failedCorrelation,
        phase: "settled",
        occurredAt: "2026-08-28T00:00:01.005Z",
        outcome: "failed",
        durationMs: 5,
      },
    ]);

    const samples = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record(observations);
        return yield* repository.sloSamples(
          Schema.decodeUnknownSync(StartupSloSampleQuery)({
            metric: "context_discovery",
            since: "2026-08-01T00:00:00.000Z",
            limit: 100,
          }),
        );
      }),
    );

    expect(samples).toEqual([
      { outcome: "failed", durationMs: 5 },
      { outcome: "reached", durationMs: 10 },
    ]);
    expect(
      evaluateStartupSlo(samples, startupSloTargets.contextDiscovery),
    ).toMatchObject({ eligible: 2, reached: 1, successRate: 0.5 });
  });

  it("measures source-backed first-token samples from source activation", async () => {
    const successfulCorrelation = Schema.decodeUnknownSync(
      StartupTraceCorrelation,
    )({
      ...correlation,
      requestId: "request-source-success-231",
      submissionId: "submission-source-success-231",
    });
    const failedCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)(
      {
        ...correlation,
        requestId: "request-source-failed-231",
        submissionId: "submission-source-failed-231",
      },
    );
    const preSourceFailedCorrelation = Schema.decodeUnknownSync(
      StartupTraceCorrelation,
    )({
      ...correlation,
      requestId: "request-source-pre-failed-231",
      submissionId: "submission-source-pre-failed-231",
    });
    const observations = Schema.decodeUnknownSync(
      Schema.Array(StartupPhaseObservation),
    )([
      {
        correlation: successfulCorrelation,
        phase: "request_admitted",
        occurredAt: "2026-08-28T00:01:00.000Z",
        outcome: "reached",
        durationMs: 1,
      },
      {
        correlation: successfulCorrelation,
        phase: "source_activated",
        occurredAt: "2026-08-28T00:02:00.000Z",
        outcome: "reached",
        durationMs: 60_001,
      },
      {
        correlation: successfulCorrelation,
        phase: "model_requested",
        occurredAt: "2026-08-28T00:02:00.100Z",
        outcome: "reached",
        durationMs: 60_101,
      },
      {
        correlation: successfulCorrelation,
        phase: "model_first_token",
        occurredAt: "2026-08-28T00:02:00.250Z",
        outcome: "reached",
        durationMs: 60_251,
      },
      {
        correlation: failedCorrelation,
        phase: "request_admitted",
        occurredAt: "2026-08-28T00:03:00.000Z",
        outcome: "reached",
        durationMs: 2,
      },
      {
        correlation: failedCorrelation,
        phase: "source_activated",
        occurredAt: "2026-08-28T00:04:00.000Z",
        outcome: "reached",
        durationMs: 60_002,
      },
      {
        correlation: failedCorrelation,
        phase: "settled",
        occurredAt: "2026-08-28T00:04:00.400Z",
        outcome: "failed",
        durationMs: 60_402,
      },
      {
        correlation: preSourceFailedCorrelation,
        phase: "request_admitted",
        occurredAt: "2026-08-28T00:05:00.000Z",
        outcome: "reached",
        durationMs: 2,
      },
      {
        correlation: preSourceFailedCorrelation,
        phase: "settled",
        occurredAt: "2026-08-28T00:05:00.500Z",
        outcome: "failed",
        durationMs: 300_500,
      },
    ]);

    const samples = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record(observations);
        return yield* repository.sloSamples(
          Schema.decodeUnknownSync(StartupSloSampleQuery)({
            metric: "source_backed_first_token",
            since: "2026-08-01T00:00:00.000Z",
            limit: 100,
          }),
        );
      }),
    );

    expect(samples).toEqual([
      { outcome: "failed", durationMs: 300_500 },
      { outcome: "failed", durationMs: 400 },
      { outcome: "reached", durationMs: 250 },
    ]);

    const modelRequestSamples = await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        return yield* repository.sloSamples(
          Schema.decodeUnknownSync(StartupSloSampleQuery)({
            metric: "source_backed_model_request",
            since: "2026-08-01T00:00:00.000Z",
            limit: 100,
          }),
        );
      }),
    );

    expect(modelRequestSamples).toEqual([
      { outcome: "failed", durationMs: 300_500 },
      { outcome: "failed", durationMs: 400 },
      { outcome: "reached", durationMs: 100 },
    ]);
  });

  it("rejects application mutation and deletes only after fixed expiry", async () => {
    await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record([accepted]);
      }),
    );

    await expect(
      env.DB.prepare(
        "UPDATE startup_phase_event SET duration_ms = 1 WHERE request_id = ?",
      )
        .bind(correlation.requestId)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      env.DB.prepare("DELETE FROM startup_phase_event WHERE request_id = ?")
        .bind(correlation.requestId)
        .run(),
    ).rejects.toBeDefined();
    await expect(
      purgeStartupPhasesBefore(env.DB, "2026-09-26T23:59:59.999Z"),
    ).resolves.toMatchObject({ meta: { changes: 0 } });
    await expect(
      purgeStartupPhasesBefore(env.DB, "2026-09-27T00:00:00.000Z"),
    ).resolves.toMatchObject({ meta: { changes: 1 } });
  });

  it("enforces monotonic transitions in D1", async () => {
    await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record([accepted]);
      }),
    );

    await expect(
      runStartup(
        Effect.gen(function* () {
          const repository = yield* StartupPhaseRepository;
          yield* repository.record([admitted]);
        }),
      ),
    ).rejects.toMatchObject({
      _tag: "PersistenceUnavailable",
      operation: "startup-phase.record",
    });

    const failedCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)(
      {
        ...correlation,
        requestId: "request-failed-231",
      },
    );
    const failed = Schema.decodeUnknownSync(StartupPhaseObservation)({
      correlation: failedCorrelation,
      phase: "flue_queued",
      occurredAt: "2026-08-28T00:00:00.000Z",
      outcome: "failed",
      durationMs: 10,
    });
    const advanced = Schema.decodeUnknownSync(StartupPhaseObservation)({
      correlation: failedCorrelation,
      phase: "flue_running",
      occurredAt: "2026-08-28T00:00:00.001Z",
      outcome: "reached",
      durationMs: 11,
    });
    await runStartup(
      Effect.gen(function* () {
        const repository = yield* StartupPhaseRepository;
        yield* repository.record([failed]);
      }),
    );
    await expect(
      runStartup(
        Effect.gen(function* () {
          const repository = yield* StartupPhaseRepository;
          yield* repository.record([advanced]);
        }),
      ),
    ).rejects.toMatchObject({ _tag: "PersistenceUnavailable" });
  });
});
