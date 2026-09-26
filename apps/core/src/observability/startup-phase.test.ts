import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  appendStartupPhase,
  StartupPhaseObservation,
  StartupPhaseRegression,
  StartupTraceCorrelation,
  startStartupTimeline,
  startupPhaseOrdinal,
  startupPhases,
} from "./startup-phase.js";

const submissionCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)(
  {
    journey: "submission",
    requestId: "request-1",
    threadId: "thr_00000000-0000-4000-8000-000000000231",
    submissionId: "submission-1",
  },
);

const submissionObservation = (
  phase: "request_admitted" | "submission_accepted" | "flue_queued",
  durationMs: number,
) =>
  Schema.decodeUnknownSync(StartupPhaseObservation)({
    correlation: submissionCorrelation,
    phase,
    occurredAt: "2026-08-28T00:00:00.000Z",
    outcome: "reached",
    durationMs,
  });

describe("startup phase timeline", () => {
  it("declares the complete thread-create path without removed budget admission", () => {
    expect(startupPhases.thread_create).toEqual({
      request_admitted: 0,
      source_authorized: 1,
      thread_persisted: 3,
      response_ready: 4,
    });
    expect(() =>
      Schema.decodeUnknownSync(StartupPhaseObservation)({
        correlation: {
          journey: "thread_create",
          requestId: "request-stale-budget",
          threadId: "thr_00000000-0000-4000-8000-000000000231",
        },
        phase: "budget_admitted",
        occurredAt: "2026-08-28T00:00:00.000Z",
        outcome: "reached",
        durationMs: 1,
      }),
    ).toThrow();
  });

  it("keeps daemon activation independent from the ordered submission path", () => {
    expect(
      [
        "changes_synced",
        "context_discovered",
        "model_requested",
        "model_first_token",
        "settled",
      ].map((phase) =>
        startupPhaseOrdinal({
          correlation: submissionCorrelation,
          phase,
        }),
      ),
    ).toEqual([6, 7, 8, 9, 10]);
    const daemonCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)(
      { ...submissionCorrelation, journey: "submission_daemon_activation" },
    );
    expect(
      [
        "requested",
        "release_loaded",
        "installed",
        "connected",
        "environment_ready",
        "workspace_ready",
      ].map((phase) =>
        startupPhaseOrdinal({ correlation: daemonCorrelation, phase }),
      ),
    ).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("appends monotonic phases and treats a duplicate phase as idempotent", () => {
    const admitted = appendStartupPhase(
      startStartupTimeline(submissionCorrelation),
      submissionObservation("request_admitted", 4),
    );
    const accepted = appendStartupPhase(
      admitted,
      submissionObservation("submission_accepted", 11),
    );

    expect(
      appendStartupPhase(
        accepted,
        submissionObservation("submission_accepted", 12),
      ),
    ).toBe(accepted);
    expect(accepted.observations.map(({ phase }) => phase)).toEqual([
      "request_admitted",
      "submission_accepted",
    ]);
    expect(
      appendStartupPhase(
        accepted,
        submissionObservation("request_admitted", 99),
      ),
    ).toBe(accepted);
  });

  it("rejects an unseen lower phase", () => {
    const queued = appendStartupPhase(
      startStartupTimeline(submissionCorrelation),
      submissionObservation("flue_queued", 20),
    );

    expect(() =>
      appendStartupPhase(
        queued,
        submissionObservation("submission_accepted", 11),
      ),
    ).toThrow(StartupPhaseRegression);
  });

  it("rejects correlation changes, terminal alternatives, and advance after termination", () => {
    const failed = appendStartupPhase(
      startStartupTimeline(submissionCorrelation),
      Schema.decodeUnknownSync(StartupPhaseObservation)({
        correlation: submissionCorrelation,
        phase: "flue_queued",
        occurredAt: "2026-08-28T00:00:00.000Z",
        outcome: "failed",
        durationMs: 20,
      }),
    );
    const otherCorrelation = Schema.decodeUnknownSync(StartupTraceCorrelation)({
      ...submissionCorrelation,
      submissionId: "other-submission",
    });
    expect(() =>
      appendStartupPhase(
        failed,
        Schema.decodeUnknownSync(StartupPhaseObservation)({
          correlation: otherCorrelation,
          phase: "flue_queued",
          occurredAt: "2026-08-28T00:00:00.000Z",
          outcome: "reached",
          durationMs: 20,
        }),
      ),
    ).toThrow("Startup correlation changed.");
    expect(() =>
      appendStartupPhase(
        failed,
        Schema.decodeUnknownSync(StartupPhaseObservation)({
          correlation: submissionCorrelation,
          phase: "flue_running",
          occurredAt: "2026-08-28T00:00:00.001Z",
          outcome: "reached",
          durationMs: 21,
        }),
      ),
    ).toThrow("Startup advanced after termination.");

    const terminalCorrelation = Schema.decodeUnknownSync(
      StartupPhaseObservation,
    )({
      correlation: {
        journey: "terminal",
        requestId: "terminal-request",
        threadId: submissionCorrelation.threadId,
      },
      phase: "workspace_waking",
      occurredAt: "2026-08-28T00:00:00.000Z",
      outcome: "reached",
      durationMs: 20,
    });
    const waking = appendStartupPhase(
      startStartupTimeline(terminalCorrelation.correlation),
      terminalCorrelation,
    );
    expect(() =>
      appendStartupPhase(
        waking,
        Schema.decodeUnknownSync(StartupPhaseObservation)({
          correlation: terminalCorrelation.correlation,
          phase: "workspace_starting",
          occurredAt: "2026-08-28T00:00:00.001Z",
          outcome: "reached",
          durationMs: 21,
        }),
      ),
    ).toThrow("Startup phase alternative changed.");
  });

  it("allows only aggregate context-discovery evidence", () => {
    const context = Schema.decodeUnknownSync(StartupPhaseObservation)({
      correlation: submissionCorrelation,
      phase: "context_discovered",
      occurredAt: "2026-08-28T00:00:00.000Z",
      outcome: "reached",
      durationMs: 82,
      operationCount: 14,
      path: "/private/repository",
      content: "private",
    });

    expect(Object.keys(context).sort()).toEqual([
      "correlation",
      "durationMs",
      "occurredAt",
      "operationCount",
      "outcome",
      "phase",
    ]);
    expect(() =>
      Schema.decodeUnknownSync(StartupPhaseObservation)({
        correlation: submissionCorrelation,
        phase: "context_discovered",
        occurredAt: "2026-08-28T00:00:00.000Z",
        outcome: "reached",
        durationMs: 82,
      }),
    ).toThrow();
  });
});
