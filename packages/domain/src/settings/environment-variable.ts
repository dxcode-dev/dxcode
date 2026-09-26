import { Effect, Schema } from "effect";
import { PageCursor } from "../pagination/cursor.js";
import { InvalidPageCursor } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { ProjectId } from "../projects/project-id.js";
import { UserId } from "../users/user-id.js";
import { WorkspaceId } from "./workspace.js";

export const MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH = 64;
export const MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES = 32_768;
export const MAX_ENVIRONMENT_VARIABLES_PER_SCOPE = 100;
export const MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS = 100;
export const MASKED_SECRET_VALUE = "••••••••";

export const EnvironmentVariableId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/EnvironmentVariableId"));

export type EnvironmentVariableId = typeof EnvironmentVariableId.Type;

export const EnvironmentVariableAuditId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/EnvironmentVariableAuditId"));

export type EnvironmentVariableAuditId = typeof EnvironmentVariableAuditId.Type;

export const EnvironmentVariableName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH),
  Schema.isPattern(/^[A-Z_][A-Z0-9_]*$/),
).pipe(Schema.brand("@dx/EnvironmentVariableName"));

export type EnvironmentVariableName = typeof EnvironmentVariableName.Type;

export const EnvironmentVariableKind = Schema.Literals(["secret", "variable"]);

export type EnvironmentVariableKind = typeof EnvironmentVariableKind.Type;

export const EnvironmentVariableScope = Schema.Literals([
  "personal",
  "project",
  "workspace",
]);

export type EnvironmentVariableScope = typeof EnvironmentVariableScope.Type;

export const EnvironmentVariableConfigReference = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("environment-variable"),
  id: EnvironmentVariableId,
});

export type EnvironmentVariableConfigReference =
  typeof EnvironmentVariableConfigReference.Type;

export const IntegrationCredentialConfigReference = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("integration-credential"),
  id: EnvironmentVariableId,
});

export type IntegrationCredentialConfigReference =
  typeof IntegrationCredentialConfigReference.Type;

export const ModelCredentialConfigReference = Schema.Struct({
  version: Schema.Literal(1),
  kind: Schema.Literal("model-credential"),
  id: EnvironmentVariableId,
});

export type ModelCredentialConfigReference =
  typeof ModelCredentialConfigReference.Type;

export const ConfigReference = Schema.Union([
  EnvironmentVariableConfigReference,
  IntegrationCredentialConfigReference,
  ModelCredentialConfigReference,
]);

export type ConfigReference = typeof ConfigReference.Type;

export const PersonalEnvironmentVariableTarget = Schema.Struct({
  scope: Schema.Literal("personal"),
  id: UserId,
});

export const ProjectEnvironmentVariableTarget = Schema.Struct({
  scope: Schema.Literal("project"),
  id: ProjectId,
});

export const WorkspaceEnvironmentVariableTarget = Schema.Struct({
  scope: Schema.Literal("workspace"),
  id: WorkspaceId,
});

export const EnvironmentVariableTarget = Schema.Union([
  PersonalEnvironmentVariableTarget,
  ProjectEnvironmentVariableTarget,
  WorkspaceEnvironmentVariableTarget,
]);

export type EnvironmentVariableTarget = typeof EnvironmentVariableTarget.Type;

const Base64 = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(65_536),
  Schema.isPattern(/^[A-Za-z0-9+/]+={0,2}$/),
);

export const EnvironmentVariableEnvelope = Schema.Struct({
  version: Schema.Literal(1),
  keyVersion: Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)),
  valueNonce: Base64,
  ciphertext: Base64,
  wrappedKeyNonce: Base64,
  wrappedKey: Base64,
});

export type EnvironmentVariableEnvelope =
  typeof EnvironmentVariableEnvelope.Type;

export const StoredEnvironmentVariable = Schema.Struct({
  id: EnvironmentVariableId,
  target: EnvironmentVariableTarget,
  name: EnvironmentVariableName,
  kind: EnvironmentVariableKind,
  enabled: Schema.Boolean,
  envelope: EnvironmentVariableEnvelope,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  rotatedAt: Timestamp,
});

export type StoredEnvironmentVariable = typeof StoredEnvironmentVariable.Type;

export const EnvironmentVariableAuditAction = Schema.Literals([
  "create",
  "update",
  "rotate",
  "delete",
]);

export type EnvironmentVariableAuditAction =
  typeof EnvironmentVariableAuditAction.Type;

export const EnvironmentVariableAuditRecord = Schema.Struct({
  id: EnvironmentVariableAuditId,
  target: EnvironmentVariableTarget,
  variableId: EnvironmentVariableId,
  name: EnvironmentVariableName,
  kind: EnvironmentVariableKind,
  action: EnvironmentVariableAuditAction,
  actorUserId: UserId,
  requestId: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(256),
  ),
  occurredAt: Timestamp,
});

export type EnvironmentVariableAuditRecord =
  typeof EnvironmentVariableAuditRecord.Type;

export const EnvironmentVariableAuditEvent = Schema.Struct({
  ...EnvironmentVariableAuditRecord.fields,
  actorName: Schema.String,
});

export type EnvironmentVariableAuditEvent =
  typeof EnvironmentVariableAuditEvent.Type;

const EnvironmentVariableAuditCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        v: Schema.Literal(1),
        scope: EnvironmentVariableScope,
        targetId: Schema.String,
        occurredAt: Timestamp,
        id: EnvironmentVariableAuditId,
      }),
    ),
  ),
);

export interface EnvironmentVariableAuditCursorPosition {
  readonly target: EnvironmentVariableTarget;
  readonly occurredAt: Timestamp;
  readonly id: EnvironmentVariableAuditId;
}

export const encodeEnvironmentVariableAuditCursor = (
  position: EnvironmentVariableAuditCursorPosition,
) =>
  Schema.encodeEffect(EnvironmentVariableAuditCursorCodec)({
    v: 1,
    scope: position.target.scope,
    targetId: position.target.id,
    occurredAt: position.occurredAt,
    id: position.id,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)));

export const decodeEnvironmentVariableAuditCursor = (
  cursor: unknown,
): Effect.Effect<EnvironmentVariableAuditCursorPosition, InvalidPageCursor> =>
  Schema.decodeUnknownEffect(PageCursor)(cursor).pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(EnvironmentVariableAuditCursorCodec),
    ),
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(EnvironmentVariableTarget)({
        scope: value.scope,
        id: value.targetId,
      }).pipe(
        Effect.map((target) => ({
          target,
          occurredAt: value.occurredAt,
          id: value.id,
        })),
      ),
    ),
    Effect.mapError(() => new InvalidPageCursor()),
  );

export const EnvironmentVariablePlaintext = Schema.String.check(
  Schema.makeFilter((value) => {
    const encoded = new TextEncoder().encode(value);
    return (
      encoded.byteLength >= 1 &&
      encoded.byteLength <= MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES &&
      !value.includes("\0") &&
      new TextDecoder().decode(encoded) === value
    );
  }),
).pipe(Schema.brand("@dx/EnvironmentVariablePlaintext"));

export type EnvironmentVariablePlaintext =
  typeof EnvironmentVariablePlaintext.Type;

const reservedNames = new Set([
  "BASHPID",
  "BASHOPTS",
  "BASH_ENV",
  "BASH_VERSION",
  "BASH_VERSINFO",
  "BETTER_AUTH_SECRET",
  "CI",
  "COLUMNS",
  "DX_ACCESS_AUDIENCE",
  "DX_ACCESS_ISSUER",
  "DX_AUTH_TRUSTED_ORIGINS",
  "DX_AUTH_URL",
  "DX_CONFIG_ENCRYPTION_KEYS",
  "DX_E2B_TEMPLATE",
  "DX_E2B_TIMEOUT_MS",
  "DX_ENV",
  "DX_EXPERIMENTAL_FEATURE_FIXTURE",
  "DX_INTEGRATION_BITBUCKET_OAUTH",
  "DX_INTEGRATION_FORGEJO_OAUTH",
  "DX_INTEGRATION_GITHUB_APP",
  "DX_INTEGRATION_GITLAB_OAUTH",
  "DX_BITBUCKET_GIT_TOKEN",
  "DX_BITBUCKET_GIT_ORIGIN",
  "DX_BITBUCKET_GIT_PATH",
  "DX_MANAGED_SSH_SIGNING_ENABLED",
  "DX_MODEL_DEPLOYMENT_PROVIDERS",
  "DX_MODEL_ENDPOINT_ALLOWLIST",
  "DX_RUNNER_PROFILE_CATALOG",
  "DX_SOURCE_COMMAND_SOCKET",
  "DX_STORAGE",
  "ENV",
  "E2B_API_KEY",
  "EUID",
  "HOME",
  "HOSTNAME",
  "HISTFILE",
  "HISTFILESIZE",
  "HISTSIZE",
  "IFS",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LINES",
  "LOGNAME",
  "NODE_OPTIONS",
  "PATH",
  "PPID",
  "PWD",
  "SHELL",
  "SHELLOPTS",
  "SHLVL",
  "TERM",
  "TMUX",
  "TMUX_PANE",
  "UID",
  "USER",
  "_",
]);

export const normalizeEnvironmentVariableName = (value: string): string =>
  value.trim();

export const isReservedEnvironmentVariableName = (name: string): boolean =>
  reservedNames.has(name) ||
  name.startsWith("CLOUDFLARE_") ||
  name.startsWith("CF_") ||
  name.startsWith("DYLD_");

export const configReferenceFor = (
  id: EnvironmentVariableId,
): EnvironmentVariableConfigReference => ({
  version: 1,
  kind: "environment-variable",
  id,
});

export const integrationCredentialReferenceFor = (
  id: EnvironmentVariableId,
): IntegrationCredentialConfigReference => ({
  version: 1,
  kind: "integration-credential",
  id,
});
