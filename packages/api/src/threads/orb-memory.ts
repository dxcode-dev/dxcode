import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/**
 * An Orb is under memory pressure from this share of its memory in use.
 * The same on every Execution provider: the resident daemon measures it.
 */
export const ORB_MEMORY_PRESSURE_PERCENT = 75;

/** Whether `usedBytes` of `totalBytes` is memory pressure. */
export const isOrbMemoryPressure = (usedBytes: number, totalBytes: number) =>
  totalBytes > 0 && usedBytes * 100 >= totalBytes * ORB_MEMORY_PRESSURE_PERCENT;

const Bytes = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
);

/**
 * One process: `<pid>-<start time>`. It never names a later process that
 * reuses the PID, so a stop can only reach the process that was listed.
 */
export const OrbProcessIdSchema = Schema.String.check(
  Schema.isMaxLength(32),
  Schema.isPattern(/^[1-9][0-9]{0,9}-(?:0|[1-9][0-9]{0,19})$/),
);
export type OrbProcessId = typeof OrbProcessIdSchema.Type;

/**
 * `stopping` from the stop request until it exits (`SIGTERM`, then
 * `SIGKILL` five seconds later); `stopped` stays listed for a minute.
 */
export const OrbProcessStateSchema = Schema.Literals([
  "running",
  "stopping",
  "stopped",
]);
export type OrbProcessState = typeof OrbProcessStateSchema.Type;

/**
 * A process the Thread's workspace user runs. dx's own processes (the
 * Orb's init, the resident daemon, Orb tooling, a Claude Code run's CLI)
 * are never listed.
 * A stopped process keeps the memory it last held.
 */
export const OrbProcessSchema = Schema.Struct({
  id: OrbProcessIdSchema,
  pid: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: 4_294_967_295 }),
  ),
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(80)),
  command: Schema.String.check(Schema.isMaxLength(256)),
  memoryBytes: Bytes,
  state: OrbProcessStateSchema,
});
export type OrbProcess = typeof OrbProcessSchema.Type;

export const OrbMemoryUsageSchema = Schema.Struct({
  usedBytes: Bytes,
  totalBytes: Bytes,
  /** `usedBytes` is at least `pressurePercent` of `totalBytes`. */
  pressure: Schema.Boolean,
  pressurePercent: Schema.Literal(ORB_MEMORY_PRESSURE_PERCENT),
});
export type OrbMemoryUsage = typeof OrbMemoryUsageSchema.Type;

/**
 * The Thread's Orb memory. Reading never wakes a paused workspace (it
 * reports `paused`). A running workspace whose daemon cannot report memory
 * omits `memory`. `processes` lists the five largest running processes and
 * every process stopped through this API in the last minute, largest
 * first.
 */
export const ThreadOrbMemoryDataSchema = Schema.Struct({
  workspace: Schema.Literals(["running", "paused", "unavailable"]),
  memory: Schema.optional(OrbMemoryUsageSchema),
  processes: Schema.Array(OrbProcessSchema).check(Schema.isMaxLength(16)),
});
export type ThreadOrbMemoryData = typeof ThreadOrbMemoryDataSchema.Type;

export const GetThreadOrbMemoryResponseSchema = successResponse(
  ThreadOrbMemoryDataSchema,
);
export type GetThreadOrbMemoryResponse =
  typeof GetThreadOrbMemoryResponseSchema.Encoded;

/** Stopping is idempotent: asking again answers the current state. */
export const StopThreadOrbProcessResponseSchema = successResponse(
  Schema.Struct({
    id: OrbProcessIdSchema,
    state: Schema.Literals(["stopping", "stopped"]),
  }),
);
export type StopThreadOrbProcessResponse =
  typeof StopThreadOrbProcessResponseSchema.Encoded;

/** Process names and commands are Terminal-level detail: Contribute access. */
export const ThreadOrbMemoryReadOnlyResponseSchema = errorResponse(
  "THREAD_READ_ONLY",
  "Only contributors can see and stop Orb processes in a shared Thread.",
);

export const ThreadOrbProcessErrorCode = Schema.Literals([
  "INVALID_REQUEST",
  "ORB_PROCESS_NOT_FOUND",
  "ORB_PROCESS_PROTECTED",
  "WORKSPACE_PAUSED",
  "WORKSPACE_UNAVAILABLE",
]);
export type ThreadOrbProcessErrorCode = typeof ThreadOrbProcessErrorCode.Type;

/**
 * A stop was refused: the process already exited or never matched
 * (`ORB_PROCESS_NOT_FOUND`, 404), it is one of dx's own
 * (`ORB_PROCESS_PROTECTED`, 403), or the workspace is paused (409) or
 * unreachable (503). Stopping never wakes a workspace.
 */
export const ThreadOrbProcessErrorResponseSchema = Schema.Struct({
  status: Schema.Literal("error"),
  data: Schema.Struct({
    code: ThreadOrbProcessErrorCode,
    message: Schema.String,
    requestId: Schema.String,
  }),
});
