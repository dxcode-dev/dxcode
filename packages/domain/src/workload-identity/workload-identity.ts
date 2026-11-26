import { Schema } from "effect";
import { ORB_PROVIDER_IDS } from "../orb-providers/index.js";

export const WORKLOAD_IDENTITY_TOKEN_USE = "dx_workload_identity_v1" as const;

export const WorkloadIdentityAudience = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.isPattern(/^[\x21-\x7e]+$/),
);
export type WorkloadIdentityAudience = typeof WorkloadIdentityAudience.Type;

export const WorkloadIdentityTtlSeconds = Schema.Number.check(
  Schema.isInt(),
  Schema.isBetween({ minimum: 60, maximum: 3_600 }),
);
export type WorkloadIdentityTtlSeconds = typeof WorkloadIdentityTtlSeconds.Type;

/** The Orb provider the workload runs on. */
export const WorkloadIdentityRuntimeProvider =
  Schema.Literals(ORB_PROVIDER_IDS);
export type WorkloadIdentityRuntimeProvider =
  typeof WorkloadIdentityRuntimeProvider.Type;

export const WorkloadIdentityRuntimeAssurance = Schema.Literals([
  "dx_dxd_channel_v1",
  "dx_provider_attested_v1",
]);
export type WorkloadIdentityRuntimeAssurance =
  typeof WorkloadIdentityRuntimeAssurance.Type;

/**
 * The assurance of a token Core minted for a plugin's function code, which
 * runs inside dx: no Orb, no dxd channel, no provider attestation. Only
 * plugin install tokens carry it (`plugin_runtime: "function"`); a Thread's
 * token never does.
 */
export const WORKLOAD_IDENTITY_CORE_FUNCTION_ASSURANCE = "dx_core_function_v1";

/** Every `runtime_assurance` a dx token can carry. */
export const WorkloadIdentityClaimRuntimeAssurance = Schema.Literals([
  "dx_dxd_channel_v1",
  "dx_provider_attested_v1",
  WORKLOAD_IDENTITY_CORE_FUNCTION_ASSURANCE,
]);

export class WorkloadIdentityUnauthorized extends Schema.TaggedError<WorkloadIdentityUnauthorized>()(
  "WorkloadIdentityUnauthorized",
  {},
) {}

export class WorkloadIdentityUnavailable extends Schema.TaggedError<WorkloadIdentityUnavailable>()(
  "WorkloadIdentityUnavailable",
  {},
) {}
