import {
  WorkloadIdentityAudience,
  WorkloadIdentityRuntimeAssurance,
  WorkloadIdentityTtlSeconds,
} from "@dx/domain";
import { Schema } from "effect";

export const IssueWorkloadIdentityRequestSchema = Schema.Struct({
  audience: WorkloadIdentityAudience,
  ttlSeconds: Schema.optional(WorkloadIdentityTtlSeconds),
});

export type IssueWorkloadIdentityRequest =
  typeof IssueWorkloadIdentityRequestSchema.Type;

export const IssueWorkloadIdentityResultSchema = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("issued"),
    token: Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(16_384),
      Schema.isPattern(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/),
    ),
    expiresAt: Schema.Int.check(Schema.isGreaterThan(0)),
  }),
  Schema.Struct({
    kind: Schema.Literals(["unauthorized", "unavailable"]),
  }),
]);

export type IssueWorkloadIdentityResult =
  typeof IssueWorkloadIdentityResultSchema.Type;

export const WorkloadIdentityDiscoveryResponseSchema = Schema.Struct({
  issuer: Schema.String,
  jwks_uri: Schema.String,
  response_types_supported: Schema.Tuple([Schema.Literal("id_token")]),
  subject_types_supported: Schema.Tuple([Schema.Literal("public")]),
  id_token_signing_alg_values_supported: Schema.Tuple([
    Schema.Literal("RS256"),
  ]),
  claims_supported: Schema.Array(Schema.String),
});

export type WorkloadIdentityDiscoveryResponse =
  typeof WorkloadIdentityDiscoveryResponseSchema.Type;

export const WorkloadIdentityPublicJwkSchema = Schema.Struct({
  kty: Schema.Literal("RSA"),
  use: Schema.Literal("sig"),
  alg: Schema.Literal("RS256"),
  kid: Schema.String,
  n: Schema.String,
  e: Schema.String,
});

export const WorkloadIdentityJwksResponseSchema = Schema.Struct({
  keys: Schema.Array(WorkloadIdentityPublicJwkSchema),
});

export type WorkloadIdentityJwksResponse =
  typeof WorkloadIdentityJwksResponseSchema.Type;

export const WorkloadIdentityRuntimeAssuranceClaimSchema =
  WorkloadIdentityRuntimeAssurance;
