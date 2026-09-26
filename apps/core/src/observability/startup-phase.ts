import { ThreadId } from "@dx/domain";
import { Schema } from "effect";

export const STARTUP_PHASE_RETENTION_DAYS = 30;

export const startupPhases = {
  thread_create: {
    request_admitted: 0,
    source_authorized: 1,
    thread_persisted: 3,
    response_ready: 4,
  },
  submission: {
    request_admitted: 0,
    submission_accepted: 1,
    flue_queued: 2,
    flue_running: 3,
    workspace_resolved: 4,
    source_activated: 5,
    changes_synced: 6,
    context_discovered: 7,
    model_requested: 8,
    model_first_token: 9,
    settled: 10,
  },
  submission_daemon_activation: {
    requested: 0,
    release_loaded: 1,
    installed: 2,
    connected: 3,
    environment_ready: 4,
    workspace_ready: 5,
  },
  terminal: {
    request_received: 0,
    authenticated: 1,
    thread_authorized: 2,
    websocket_admitted: 3,
    durable_object_reached: 4,
    runner_profile_resolved: 5,
    runner_budget_admitted: 6,
    workspace_lock_acquired: 7,
    workspace_state_resolved: 8,
    workspace_starting: 9,
    workspace_waking: 9,
    provider_connected: 10,
    workspace_resolved: 11,
    source_activated: 12,
    changes_sync_settled: 13,
    tmux_session_checked: 14,
    tmux_history_configured: 15,
    tmux_display_configured: 16,
    pty_created: 17,
    tmux_attach_requested: 18,
    tmux_replay_captured: 19,
    inactivity_deadline_armed: 20,
    tmux_ready: 21,
    initial_resize_applied: 22,
    daemon_ready: 24,
    resident_open_dispatched: 25,
    resident_ready: 26,
    resident_attach_dispatched: 27,
    resident_replay_started: 28,
    resident_attachment_ready: 29,
    terminal_ready: 30,
  },
} as const;

export const StartupJourney = Schema.Literals([
  "thread_create",
  "submission",
  "submission_daemon_activation",
  "terminal",
]);
export type StartupJourney = typeof StartupJourney.Type;

const ThreadCreatePhase = Schema.Literals([
  "request_admitted",
  "source_authorized",
  "thread_persisted",
  "response_ready",
]);
const SubmissionPhaseWithoutContext = Schema.Literals([
  "request_admitted",
  "submission_accepted",
  "flue_queued",
  "flue_running",
  "workspace_resolved",
  "source_activated",
  "changes_synced",
  "model_requested",
  "model_first_token",
  "settled",
]);
const SubmissionDaemonActivationPhase = Schema.Literals([
  "requested",
  "release_loaded",
  "installed",
  "connected",
  "environment_ready",
  "workspace_ready",
]);
const TerminalPhase = Schema.Literals([
  "request_received",
  "authenticated",
  "thread_authorized",
  "websocket_admitted",
  "durable_object_reached",
  "runner_profile_resolved",
  "runner_budget_admitted",
  "workspace_lock_acquired",
  "workspace_state_resolved",
  "workspace_starting",
  "workspace_waking",
  "provider_connected",
  "workspace_resolved",
  "source_activated",
  "changes_sync_settled",
  "tmux_session_checked",
  "tmux_history_configured",
  "tmux_display_configured",
  "pty_created",
  "tmux_attach_requested",
  "tmux_replay_captured",
  "inactivity_deadline_armed",
  "tmux_ready",
  "initial_resize_applied",
  "daemon_ready",
  "resident_open_dispatched",
  "resident_ready",
  "resident_attach_dispatched",
  "resident_replay_started",
  "resident_attachment_ready",
  "terminal_ready",
]);

export const StartupPhaseName = Schema.Literals([
  "request_admitted",
  "source_authorized",
  "thread_persisted",
  "response_ready",
  "submission_accepted",
  "flue_queued",
  "flue_running",
  "workspace_resolved",
  "source_activated",
  "changes_synced",
  "context_discovered",
  "model_requested",
  "model_first_token",
  "settled",
  "requested",
  "release_loaded",
  "installed",
  "connected",
  "environment_ready",
  "workspace_ready",
  "request_received",
  "authenticated",
  "thread_authorized",
  "websocket_admitted",
  "durable_object_reached",
  "runner_profile_resolved",
  "runner_budget_admitted",
  "workspace_lock_acquired",
  "workspace_state_resolved",
  "workspace_starting",
  "workspace_waking",
  "provider_connected",
  "changes_sync_settled",
  "tmux_session_checked",
  "tmux_history_configured",
  "tmux_display_configured",
  "pty_created",
  "tmux_attach_requested",
  "tmux_replay_captured",
  "inactivity_deadline_armed",
  "tmux_ready",
  "initial_resize_applied",
  "daemon_ready",
  "resident_open_dispatched",
  "resident_ready",
  "resident_attach_dispatched",
  "resident_replay_started",
  "resident_attachment_ready",
  "terminal_ready",
]);
export type StartupPhaseName = typeof StartupPhaseName.Type;

export type StartupPhase<J extends StartupJourney> =
  keyof (typeof startupPhases)[J];

export const StartupRequestId = Schema.String.check(
  Schema.isPattern(/^[A-Za-z0-9._-]{1,128}$/),
).pipe(Schema.brand("@dx/StartupRequestId"));
export type StartupRequestId = typeof StartupRequestId.Type;

export const StartupSubmissionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/StartupSubmissionId"));
export type StartupSubmissionId = typeof StartupSubmissionId.Type;

const CorrelationBase = {
  requestId: StartupRequestId,
  threadId: ThreadId,
} as const;

const ThreadCreateCorrelation = Schema.Struct({
  ...CorrelationBase,
  journey: Schema.Literal("thread_create"),
});
const SubmissionCorrelation = Schema.Struct({
  ...CorrelationBase,
  journey: Schema.Literal("submission"),
  submissionId: StartupSubmissionId,
});
const SubmissionDaemonActivationCorrelation = Schema.Struct({
  ...CorrelationBase,
  journey: Schema.Literal("submission_daemon_activation"),
  submissionId: Schema.String.check(Schema.isMaxLength(128)),
});
const TerminalCorrelation = Schema.Struct({
  ...CorrelationBase,
  journey: Schema.Literal("terminal"),
});

export const StartupTraceCorrelation = Schema.Union([
  ThreadCreateCorrelation,
  SubmissionCorrelation,
  SubmissionDaemonActivationCorrelation,
  TerminalCorrelation,
]);
export type StartupTraceCorrelation = typeof StartupTraceCorrelation.Type;

export type SubmissionScopedStartupCorrelation = Extract<
  StartupTraceCorrelation,
  { readonly submissionId: StartupSubmissionId }
>;

export const isSubmissionScopedCorrelation = (
  correlation: StartupTraceCorrelation,
): correlation is SubmissionScopedStartupCorrelation =>
  correlation.journey === "submission" ||
  correlation.journey === "submission_daemon_activation";

export const StartupPhaseOutcome = Schema.Literals([
  "reached",
  "failed",
  "cancelled",
]);
export type StartupPhaseOutcome = typeof StartupPhaseOutcome.Type;

const NonNegativeInteger = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));
const ObservationBase = {
  occurredAt: Schema.DateTimeUtcFromString,
  outcome: StartupPhaseOutcome,
  durationMs: NonNegativeInteger,
} as const;

export const StartupPhaseObservation = Schema.Union([
  Schema.Struct({
    ...ObservationBase,
    correlation: ThreadCreateCorrelation,
    phase: ThreadCreatePhase,
  }),
  Schema.Struct({
    ...ObservationBase,
    correlation: SubmissionCorrelation,
    phase: SubmissionPhaseWithoutContext,
  }),
  Schema.Struct({
    ...ObservationBase,
    correlation: SubmissionCorrelation,
    phase: Schema.Literal("context_discovered"),
    operationCount: NonNegativeInteger,
  }),
  Schema.Struct({
    ...ObservationBase,
    correlation: SubmissionDaemonActivationCorrelation,
    phase: SubmissionDaemonActivationPhase,
  }),
  Schema.Struct({
    ...ObservationBase,
    correlation: TerminalCorrelation,
    phase: TerminalPhase,
  }),
]);
export type StartupPhaseObservation<J extends StartupJourney = StartupJourney> =
  Extract<
    typeof StartupPhaseObservation.Type,
    { readonly correlation: { readonly journey: J } }
  >;

export interface StartupTimeline {
  readonly correlation: StartupTraceCorrelation;
  readonly observations: ReadonlyArray<StartupPhaseObservation>;
}

export class StartupPhaseRegression extends Schema.TaggedError<StartupPhaseRegression>()(
  "StartupPhaseRegression",
  {
    reason: Schema.Literals([
      "correlation_changed",
      "advanced_after_termination",
      "phase_regressed",
      "phase_alternative_changed",
    ]),
    message: Schema.String,
  },
) {}

const phaseOrdinals: Record<
  StartupJourney,
  Readonly<Record<string, number | undefined>>
> = startupPhases;

export const startupPhaseOrdinal = (observation: {
  readonly correlation: { readonly journey: StartupJourney };
  readonly phase: string;
}): number => {
  const ordinal =
    phaseOrdinals[observation.correlation.journey][observation.phase];
  if (ordinal === undefined) throw new Error("Unknown startup phase.");
  return ordinal;
};

const sameCorrelation = (
  left: StartupTraceCorrelation,
  right: StartupTraceCorrelation,
) =>
  left.journey === right.journey &&
  left.requestId === right.requestId &&
  left.threadId === right.threadId &&
  (!isSubmissionScopedCorrelation(left) ||
    (isSubmissionScopedCorrelation(right) &&
      left.submissionId === right.submissionId));

const regression = (
  reason: StartupPhaseRegression["reason"],
  message: string,
) => new StartupPhaseRegression({ reason, message });

export const startStartupTimeline = (
  correlation: StartupTraceCorrelation,
): StartupTimeline => ({ correlation, observations: [] });

export const appendStartupPhase = (
  timeline: StartupTimeline,
  observation: StartupPhaseObservation,
): StartupTimeline => {
  if (!sameCorrelation(timeline.correlation, observation.correlation)) {
    throw regression("correlation_changed", "Startup correlation changed.");
  }
  if (timeline.observations.some(({ phase }) => phase === observation.phase)) {
    return timeline;
  }

  const nextOrdinal = startupPhaseOrdinal(observation);
  const current = timeline.observations.at(-1);
  if (current === undefined) {
    return {
      correlation: timeline.correlation,
      observations: [observation],
    };
  }

  const currentOrdinal = startupPhaseOrdinal(current);
  if (current.outcome !== "reached" && nextOrdinal > currentOrdinal) {
    throw regression(
      "advanced_after_termination",
      "Startup advanced after termination.",
    );
  }
  if (nextOrdinal < currentOrdinal) {
    throw regression("phase_regressed", "Startup phase moved backwards.");
  }
  if (nextOrdinal === currentOrdinal) {
    throw regression(
      "phase_alternative_changed",
      "Startup phase alternative changed.",
    );
  }

  return {
    correlation: timeline.correlation,
    observations: [...timeline.observations, observation],
  };
};
