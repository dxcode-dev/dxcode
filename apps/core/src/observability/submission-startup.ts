import { Result, Schema } from "effect";
import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "../http/types.js";
import {
  type StartupPhaseObservation,
  StartupTraceCorrelation,
} from "./startup-phase.js";
import {
  recordStartupPhases,
  scheduleStartupPersistence,
  startupObservation,
  startupServerTiming,
} from "./startup-runtime.js";

const flueSubmissionReceipt = async (response: Response) => {
  const body: unknown = await response
    .clone()
    .json()
    .catch(() => undefined);
  return typeof body === "object" &&
    body !== null &&
    "submissionId" in body &&
    typeof body.submissionId === "string"
    ? {
        submissionId: body.submissionId,
        deduplicated: "deduplicated" in body && body.deduplicated === true,
      }
    : undefined;
};

export const submissionStartupObservations = (
  requestId: string | undefined,
  threadId: string | undefined,
  receipt: { readonly submissionId: string; readonly deduplicated?: boolean },
  startedAt: number,
  acceptedAt = Date.now(),
): ReadonlyArray<StartupPhaseObservation> | undefined => {
  if (requestId === undefined || threadId === undefined || receipt.deduplicated)
    return undefined;
  const decodedCorrelation = Schema.decodeUnknownResult(
    StartupTraceCorrelation,
  )({
    journey: "submission",
    requestId,
    threadId,
    submissionId: receipt.submissionId,
  });
  if (Result.isFailure(decodedCorrelation)) return undefined;

  return [
    startupObservation(
      decodedCorrelation.success,
      "request_admitted",
      startedAt,
      acceptedAt,
    ),
    startupObservation(
      decodedCorrelation.success,
      "submission_accepted",
      startedAt,
      acceptedAt,
    ),
    startupObservation(
      decodedCorrelation.success,
      "flue_queued",
      startedAt,
      acceptedAt,
    ),
  ];
};

/** Records submission milestones without participating in admission. */
export const submissionStartupObservation: MiddlewareHandler<AppEnv> = async (
  context,
  next,
) => {
  const startedAt = Date.now();
  if (context.req.method !== "POST") return next();
  // Preserve Flue's native response for this legacy unsupported query shape.
  if (new URL(context.req.url).searchParams.has("wait")) return next();
  const threadId = context.req.param("threadId");

  await next();
  if (context.res.status !== 202) return;
  const receipt = await flueSubmissionReceipt(context.res);
  if (receipt === undefined) return;
  const observations = submissionStartupObservations(
    context.get("requestId"),
    threadId,
    receipt,
    startedAt,
  );
  if (observations === undefined) return;
  context.header("Server-Timing", startupServerTiming(observations));
  await scheduleStartupPersistence(
    () => context.executionCtx,
    recordStartupPhases(context.env.DB, observations),
  );
};
