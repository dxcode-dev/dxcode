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

export class WorkloadIdentityUnauthorized extends Schema.TaggedError<WorkloadIdentityUnauthorized>()(
  "WorkloadIdentityUnauthorized",
  {},
) {}

export class WorkloadIdentityUnavailable extends Schema.TaggedError<WorkloadIdentityUnavailable>()(
  "WorkloadIdentityUnavailable",
  {},
) {}
