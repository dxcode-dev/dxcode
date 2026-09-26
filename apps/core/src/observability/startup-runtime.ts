import { ThreadId } from "@dx/domain";
import { DateTime, Effect, Result, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { startupObservabilityLogger } from "../logging.js";
import { decodeD1Binding } from "../persistence/d1-binding.js";
import {
  isSubmissionScopedCorrelation,
  type StartupPhase,
  type StartupPhaseName,
  type StartupPhaseObservation,
  StartupPhaseObservation as StartupPhaseObservationSchema,
  type StartupPhaseOutcome,
  type StartupTraceCorrelation,
} from "./startup-phase.js";
import { StartupPhaseRepository } from "./startup-phase-repository.js";
import { StartupPhaseRepositoryD1 } from "./startup-phase-repository-d1.js";

export const startupObservation = (
  correlation: StartupTraceCorrelation,
  phase: StartupPhaseName,
  startedAt: number,
  occurredAt = Date.now(),
  options: {
    readonly outcome?: StartupPhaseOutcome;
    readonly operationCount?: number;
  } = {},
): StartupPhaseObservation =>
  Schema.decodeUnknownSync(StartupPhaseObservationSchema)({
    correlation,
    phase,
    occurredAt: new Date(occurredAt).toISOString(),
    outcome: options.outcome ?? "reached",
    durationMs: Math.max(0, Math.round(occurredAt - startedAt)),
    ...(options.operationCount === undefined
      ? {}
      : { operationCount: options.operationCount }),
  });

export const startupServerTiming = (
  observations: ReadonlyArray<StartupPhaseObservation>,
) =>
  observations
    .map(({ phase, durationMs }) => `dx_${phase};dur=${durationMs}`)
    .join(", ");

const repositoryEffect = <A, E>(
  binding: unknown,
  effect: Effect.Effect<A, E, StartupPhaseRepository>,
) =>
  Effect.gen(function* () {
    const db = yield* decodeD1Binding(binding);
    return yield* effect.pipe(Effect.provide(StartupPhaseRepositoryD1(db)));
  });

export const recordStartupPhases = async (
  binding: unknown,
  observations: ReadonlyArray<StartupPhaseObservation>,
): Promise<void> => {
  try {
    await Effect.runPromise(
      repositoryEffect(
        binding,
        Effect.flatMap(StartupPhaseRepository, (repository) =>
          repository.record(observations),
        ),
      ),
    );
  } catch {
    const correlation = observations[0]?.correlation;
    startupObservabilityLogger.warn(
      "Startup phase observation could not be recorded.",
      {
        event: "startup_phase_record_failed",
        ...(correlation === undefined
          ? {}
          : {
              journey: correlation.journey,
              requestId: correlation.requestId,
              threadId: correlation.threadId,
              ...(isSubmissionScopedCorrelation(correlation)
                ? { submissionId: correlation.submissionId }
                : {}),
            }),
      },
    );
  }
};

/** Keeps diagnostic persistence outside the response path when waitUntil exists. */
export const scheduleStartupPersistence = async (
  executionContext: () => {
    readonly waitUntil: (promise: Promise<unknown>) => void;
  },
  persistence: Promise<void>,
): Promise<void> => {
  try {
    executionContext().waitUntil(persistence);
  } catch {
    await persistence;
  }
};

const correlationDelaysMs = [0, 75, 150] as const;

const resolveSubmissionCorrelation = async (
  binding: unknown,
  unsafeThreadId: string,
  submissionId: string,
) => {
  const decoded = Schema.decodeUnknownResult(ThreadId)(unsafeThreadId);
  if (Result.isFailure(decoded)) {
    startupObservabilityLogger.warn(
      "Startup submission correlation received an invalid thread identifier.",
      { event: "startup_correlation_invalid_thread", submissionId },
    );
    return null;
  }
  const threadId = decoded.success;
  for (const delayMs of correlationDelaysMs) {
    if (delayMs > 0)
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    try {
      const result = await Effect.runPromise(
        repositoryEffect(
          binding,
          Effect.flatMap(StartupPhaseRepository, (repository) =>
            repository.submissionCorrelation(threadId, submissionId),
          ),
        ),
      );
      if (result !== null) return result;
    } catch {
      return null;
    }
  }
  startupObservabilityLogger.warn(
    "Startup submission correlation is unavailable.",
    {
      event: "startup_correlation_missing",
      threadId,
      submissionId,
    },
  );
  return null;
};

interface ActiveSubmission {
  readonly submissionId: string;
  readonly correlation: ReturnType<typeof resolveSubmissionCorrelation>;
  delivery: Promise<void>;
}

const activeSubmissions = new Map<string, ActiveSubmission>();

const enqueueActivePhase = (
  binding: unknown,
  threadId: string,
  phase: StartupPhase<"submission">,
  occurredAt: number,
  options?: {
    readonly outcome?: StartupPhaseOutcome;
    readonly operationCount?: number;
  },
) => {
  const active = activeSubmissions.get(threadId);
  if (active === undefined) return Promise.resolve();
  active.delivery = active.delivery.then(async () => {
    const resolved = await active.correlation;
    if (resolved === null) return;
    await recordStartupPhases(binding, [
      startupObservation(
        resolved.correlation,
        phase,
        DateTime.toEpochMillis(resolved.startedAt),
        occurredAt,
        options,
      ),
    ]);
  });
  return active.delivery;
};

export const startSubmissionStartup = (
  bindings: Bindings,
  threadId: string,
  submissionId: string,
  occurredAt = Date.now(),
) => {
  const current = activeSubmissions.get(threadId);
  if (current?.submissionId === submissionId)
    return enqueueActivePhase(
      bindings.DB,
      threadId,
      "flue_running",
      occurredAt,
    );
  const active: ActiveSubmission = {
    submissionId,
    correlation: resolveSubmissionCorrelation(
      bindings.DB,
      threadId,
      submissionId,
    ),
    delivery: Promise.resolve(),
  };
  activeSubmissions.set(threadId, active);
  return enqueueActivePhase(bindings.DB, threadId, "flue_running", occurredAt);
};

export const activeSubmissionId = (threadId: string): string | undefined =>
  activeSubmissions.get(threadId)?.submissionId;

export const recordActiveSubmissionPhase = (
  bindings: Bindings,
  threadId: string,
  phase: StartupPhase<"submission">,
  occurredAtOrOptions:
    | number
    | { readonly operationCount?: number } = Date.now(),
  options?: { readonly operationCount?: number },
) => {
  const occurredAt =
    typeof occurredAtOrOptions === "number" ? occurredAtOrOptions : Date.now();
  const phaseOptions =
    typeof occurredAtOrOptions === "number" ? options : occurredAtOrOptions;
  return enqueueActivePhase(
    bindings.DB,
    threadId,
    phase,
    occurredAt,
    phaseOptions,
  );
};

export const settleSubmissionStartup = (
  bindings: Bindings,
  threadId: string,
  submissionId: string,
  outcome: StartupPhaseOutcome,
  occurredAt = Date.now(),
) => {
  const active = activeSubmissions.get(threadId);
  if (active?.submissionId !== submissionId) return Promise.resolve();
  const delivery = enqueueActivePhase(
    bindings.DB,
    threadId,
    "settled",
    occurredAt,
    { outcome },
  );
  void delivery.finally(() => {
    if (activeSubmissions.get(threadId) === active)
      activeSubmissions.delete(threadId);
  });
  return delivery;
};
