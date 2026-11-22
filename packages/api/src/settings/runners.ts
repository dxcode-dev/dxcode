import { Schema } from "effect";
import { errorResponse, successResponse } from "../http/response.js";

/** A paired machine: `rnm_` and 24 lowercase hex characters. */
export const RunnerMachineId = Schema.String.check(
  Schema.isPattern(/^rnm_[0-9a-f]{24}$/),
);

export type RunnerMachineId = typeof RunnerMachineId.Type;

/** One of the person's own machines that Threads can run on. */
export const RunnerMachineSchema = Schema.Struct({
  id: RunnerMachineId,
  /** The name given when it was paired, such as `studio-mac`. */
  name: Schema.String,
  os: Schema.Literals(["macos", "linux"]),
  /** `aarch64` or `x86_64`. */
  arch: Schema.String,
  /** The runner's version as it last reported it. */
  version: Schema.String,
  /** Connected to dx now. */
  online: Schema.Boolean,
  /** Epoch ms of the last heartbeat; null before it ever connected. */
  lastSeenAt: Schema.NullOr(Schema.Number),
  createdAt: Schema.Number,
});

export type RunnerMachine = typeof RunnerMachineSchema.Type;

export const RunnerListDataSchema = Schema.Struct({
  runners: Schema.Array(RunnerMachineSchema),
});

export type RunnerListData = typeof RunnerListDataSchema.Type;

export const ListRunnersResponseSchema = successResponse(RunnerListDataSchema);

/** A one-time code and the one command that installs and pairs a runner. */
export const RunnerPairingSchema = Schema.Struct({
  code: Schema.String,
  /** Epoch ms after which the code no longer pairs. */
  expiresAt: Schema.Number,
  /** `curl -fsSL https://<origin>/runner/install.sh | sh -s -- --code <code>` */
  command: Schema.String,
});

export type RunnerPairing = typeof RunnerPairingSchema.Type;

export const CreateRunnerPairingResponseSchema =
  successResponse(RunnerPairingSchema);

export const RemoveRunnerResponseSchema = successResponse(
  Schema.Struct({ removed: Schema.Boolean }),
);

export const RunnersUnavailableResponseSchema = errorResponse(
  "PERSISTENCE_UNAVAILABLE",
  "Runners are temporarily unavailable.",
);

/** The Orb provider id and its one size; each Thread names its machine. */
// Typed as strings so they compare with Orb provider and size ids whether
// or not the domain's provider list names `runner` yet.
export const RUNNER_PROVIDER_ID: string = "runner";
export const RUNNER_PROFILE_ID: string = "rn.machine";
