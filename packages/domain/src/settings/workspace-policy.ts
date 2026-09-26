import { Schema } from "effect";
import { RunnerAdapterKind, RunnerProfileId } from "./runner-profile.js";
import { WorkspaceId } from "./workspace.js";

export const WorkspacePolicyRestrictions = Schema.Struct({
  allowedRunnerProfileIds: Schema.NullOr(Schema.Array(RunnerProfileId)),
  allowRemoteRunners: Schema.Boolean,
  allowPersonalProviderOverrides: Schema.Boolean,
  allowPersonalMcpOverrides: Schema.Boolean,
  allowPersonalSecretOverrides: Schema.Boolean,
});

export type WorkspacePolicyRestrictions =
  typeof WorkspacePolicyRestrictions.Type;

export const WorkspacePolicy = Schema.Struct({
  workspaceId: WorkspaceId,
  restrictions: WorkspacePolicyRestrictions,
  revision: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  updatedAt: Schema.DateTimeUtc,
});

export type WorkspacePolicy = typeof WorkspacePolicy.Type;

export const WorkspacePolicyUpdate = Schema.Struct({
  restrictions: WorkspacePolicyRestrictions,
});

export type WorkspacePolicyUpdate = typeof WorkspacePolicyUpdate.Type;

export const defaultWorkspacePolicy = (
  workspaceId: WorkspaceId,
): WorkspacePolicy => ({
  workspaceId,
  restrictions: {
    allowedRunnerProfileIds: null,
    allowRemoteRunners: true,
    allowPersonalProviderOverrides: true,
    allowPersonalMcpOverrides: true,
    allowPersonalSecretOverrides: true,
  },
  revision: 0,
  updatedAt: Schema.decodeUnknownSync(Schema.DateTimeUtcFromString)(
    "1970-01-01T00:00:00.000Z",
  ),
});

export const WorkspacePolicyAction = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("project.create"),
    runnerProfileId: RunnerProfileId,
    runnerAdapter: RunnerAdapterKind,
  }),
  Schema.Struct({
    kind: Schema.Literal("execution.admit"),
    runnerProfileId: RunnerProfileId,
    runnerAdapter: RunnerAdapterKind,
  }),
  Schema.Struct({ kind: Schema.Literal("provider.use-personal-override") }),
  Schema.Struct({ kind: Schema.Literal("mcp.use-personal-override") }),
  Schema.Struct({ kind: Schema.Literal("secret.use-personal-override") }),
]);

export type WorkspacePolicyAction = typeof WorkspacePolicyAction.Type;

export const WorkspacePolicyDenialReason = Schema.Literals([
  "runner-profile-restricted",
  "remote-runner-disabled",
  "personal-provider-overrides-disabled",
  "personal-mcp-overrides-disabled",
  "personal-secret-overrides-disabled",
]);

export type WorkspacePolicyDenialReason =
  typeof WorkspacePolicyDenialReason.Type;

export class WorkspacePolicyDenied extends Schema.TaggedError<WorkspacePolicyDenied>()(
  "WorkspacePolicyDenied",
  { reason: WorkspacePolicyDenialReason },
) {}

export const isRemoteRunnerAdapter = (adapter: RunnerAdapterKind): boolean =>
  adapter === "e2b" || adapter === "kubernetes" || adapter === "remote";
