import { Effect, Option, Schema } from "effect";
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

/**
 * A stored value: up to 32 KiB of UTF-8 without NUL. An env var may be
 * empty (`GIT_CONFIG_VALUE_0=` resets a Git setting); a secret may not.
 */
export const EnvironmentVariableValue = Schema.String.check(
  Schema.makeFilter((value) => {
    const encoded = new TextEncoder().encode(value);
    return (
      encoded.byteLength <= MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES &&
      !value.includes("\0") &&
      new TextDecoder().decode(encoded) === value
    );
  }),
).pipe(Schema.brand("@dx/EnvironmentVariableValue"));

export type EnvironmentVariableValue = typeof EnvironmentVariableValue.Type;

export const EMPTY_SECRET_PROBLEM = "A secret must have a value.";

/**
 * Names dx sets or reads inside an Orb, where a user value would be ignored,
 * would override dx's own value, or would break dx's shells and helpers.
 * Providers start every command under `bash -l`, so the Orb profile sources
 * `~/.env` after dx's own exports and per-command variables and a user value
 * usually wins. Names that only exist in the Worker never reach an Orb and
 * are not listed. dxd keeps the same list (`RESERVED_NAMES` and
 * `RESERVED_PREFIXES` in `apps/dxd/src/environment.rs`); both must equal
 * `environment-variable-names.json`.
 */
export const RESERVED_ENVIRONMENT_VARIABLE_NAMES: ReadonlySet<string> = new Set(
  [
    // Set by the Orb shell profile, dxd's base environment, or the Terminal.
    "HOME",
    "USER",
    "LOGNAME",
    "SHELL",
    "PATH",
    "TERM",
    "TMUX",
    "TMUX_PANE",
    "HISTFILE",
    "HISTSIZE",
    "HISTFILESIZE",
    "GIT_CONFIG_GLOBAL",
    // Set by dxd for Thread services and its guest helpers.
    "PORT",
    "DX_SERVICE",
    "DX_WORKLOAD_IDENTITY_SOCKET",
    // Passed by Core to source preparation and agent commands.
    "DX_CLONE_URL",
    "DX_DEFAULT_BRANCH",
    "DX_BINDING_REVISION",
    "DX_GH_WRAPPER",
    "DX_GIT_ALLOWED_PATH",
    "DX_GIT_HELPER",
    "DX_INVOCATION_ID",
    "DX_REPOSITORIES_ROOT",
    "DX_RUN_RESUME",
    "DX_THREAD_ID",
    "FLUE_WORKSPACE_CONTEXT_ROOT",
    "CLAUDE_CODE_OAUTH_TOKEN",
    // Read by the Desktop's Chromium launcher from the calling shell.
    "WAYLAND_DISPLAY",
    // Read-only in Bash: every login shell would print an error.
    "BASHOPTS",
    "BASH_VERSINFO",
    "EUID",
    "PPID",
    "SHELLOPTS",
    "UID",
    // Change how every dx shell and process starts, or load code into it.
    "BASH_ENV",
    "ENV",
    "IFS",
    "LD_AUDIT",
    "LD_LIBRARY_PATH",
    "LD_PRELOAD",
  ],
);

export const RESERVED_ENVIRONMENT_VARIABLE_PREFIXES: ReadonlyArray<string> = [
  "DXD_",
  "DX_ASSET_",
  "DX_BITBUCKET_GIT_",
  "DX_CHANGES_",
  "DX_DESKTOP_",
  "DX_REPOSITORY_",
  "DX_SOURCE_",
  "DX_SUBMODULE_",
];

export const normalizeEnvironmentVariableName = (value: string): string =>
  value.trim();

export const isReservedEnvironmentVariableName = (name: string): boolean =>
  RESERVED_ENVIRONMENT_VARIABLE_NAMES.has(name) ||
  RESERVED_ENVIRONMENT_VARIABLE_PREFIXES.some((prefix) =>
    name.startsWith(prefix),
  );

/**
 * Why a name cannot be saved, in the words settings show under the Name
 * field; `undefined` when it can.
 */
export const environmentVariableNameProblem = (
  value: string,
): string | undefined => {
  const name = normalizeEnvironmentVariableName(value);
  if (name.length === 0) return "Enter a name.";
  if (name.length > MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH)
    return `Name must be ${MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH} characters or fewer.`;
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    return "Use uppercase letters, digits, and underscores, not starting with a digit (e.g. MY_VAR).";
  if (isReservedEnvironmentVariableName(name))
    return `${name} is set by dx in Orbs. Choose a different name.`;
  return undefined;
};

const secretNameSuffix =
  /(?:^|_)(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_KEY|PRIVATE_KEY|SECRET_KEY|CLIENT_SECRET|CREDENTIALS?|PAT)$/;

/** Whether a name ends like a credential: `_TOKEN`, `_API_KEY`, `_PASSWORD`. */
export const looksLikeSecretName = (name: string): boolean =>
  secretNameSuffix.test(name);

const commonValues = new Set([
  "changeme",
  "default",
  "development",
  "disabled",
  "enabled",
  "localhost",
  "password",
  "production",
  "staging",
  "undefined",
]);

/**
 * Whether a secret value is too short or too common to hide. dx replaces
 * every occurrence of a hidden secret in what the agent reads, so hiding a
 * secret such as `true` would garble every `true` there; dx leaves it shown.
 */
export const isWeakSecretValue = (value: string): boolean => {
  const trimmed = value.trim();
  return trimmed.length < 8 || commonValues.has(trimmed.toLowerCase());
};

/** Whether dx hides a value in what the agent reads: a secret, not weak. */
export const isHiddenEnvironmentValue = (
  kind: EnvironmentVariableKind,
  value: string,
): boolean => kind === "secret" && !isWeakSecretValue(value);

/**
 * Whether Bulk Add's "Auto-detect secrets" saves an assignment as a secret:
 * a credential-style name or a URL with a password, and never a value too
 * short or common to hide.
 */
export const looksLikeSecretEnvironmentVariable = (
  name: string,
  value: string,
): boolean =>
  !isWeakSecretValue(value) &&
  (looksLikeSecretName(name) ||
    /^[a-z][a-z0-9+.-]*:\/\/[^/@\s:]*:[^/@\s]+@/i.test(value));

export const MAX_ENVIRONMENT_VARIABLE_BULK_BYTES = 262_144;

export interface EnvironmentVariableAssignment {
  readonly line: number;
  /** The name as written, for messages about a line that did not parse. */
  readonly rawName: string;
  readonly name?: EnvironmentVariableName;
  readonly value?: EnvironmentVariableValue;
  /** Why the line cannot be added; absent when `name` and `value` are set. */
  readonly error?: string;
}

/**
 * Parses Bulk Add input: one `NAME=value` per line, an optional `export `,
 * and one pair of matching quotes around the value. Blank lines and `#`
 * comments are skipped. Settings and the server share it, so the dialog
 * shows the same per-line errors the server would return.
 */
export const parseEnvironmentVariableAssignments = (
  contents: string,
): ReadonlyArray<EnvironmentVariableAssignment> => {
  if (
    new TextEncoder().encode(contents).byteLength >
    MAX_ENVIRONMENT_VARIABLE_BULK_BYTES
  ) {
    return [{ line: 1, rawName: "", error: "Bulk input is too large." }];
  }
  const parsed = contents
    .split(/\r?\n/)
    .flatMap<EnvironmentVariableAssignment>((source, index) => {
      const line = index + 1;
      const trimmed = source.trim();
      if (trimmed.length === 0 || trimmed.startsWith("#")) return [];
      const assignment = trimmed.startsWith("export ")
        ? trimmed.slice("export ".length)
        : trimmed;
      const separator = assignment.indexOf("=");
      const rawName = (
        separator < 0 ? assignment : assignment.slice(0, separator)
      ).trim();
      if (separator < 1 || rawName.length === 0) {
        return [{ line, rawName, error: "Use NAME=value." }];
      }
      const nameProblem = environmentVariableNameProblem(rawName);
      const name = Schema.decodeUnknownOption(EnvironmentVariableName)(
        normalizeEnvironmentVariableName(rawName),
      );
      if (nameProblem !== undefined || Option.isNone(name)) {
        return [{ line, rawName, error: nameProblem ?? "Invalid name." }];
      }
      const rawValue = assignment.slice(separator + 1);
      const unquoted =
        rawValue.length >= 2 &&
        ((rawValue.startsWith('"') && rawValue.endsWith('"')) ||
          (rawValue.startsWith("'") && rawValue.endsWith("'")))
          ? rawValue.slice(1, -1)
          : rawValue;
      const value = Schema.decodeUnknownOption(EnvironmentVariableValue)(
        unquoted,
      );
      return Option.isNone(value)
        ? [
            {
              line,
              rawName,
              error: `Value must be at most ${MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES.toLocaleString("en-US")} UTF-8 bytes.`,
            },
          ]
        : [{ line, rawName, name: name.value, value: value.value }];
    });
  const counts = new Map<string, number>();
  for (const item of parsed) {
    if (item.name !== undefined)
      counts.set(item.name, (counts.get(item.name) ?? 0) + 1);
  }
  return parsed.map((item) =>
    item.name !== undefined && (counts.get(item.name) ?? 0) > 1
      ? {
          line: item.line,
          rawName: item.rawName,
          error: `${item.name} appears more than once.`,
        }
      : item,
  );
};

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
