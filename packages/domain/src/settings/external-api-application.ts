import { Effect, Schema } from "effect";
import { PageCursor } from "../pagination/cursor.js";
import { InvalidPageCursor } from "../persistence/errors.js";
import { Timestamp } from "../persistence/timestamp.js";
import { UserId } from "../users/user-id.js";
import { WorkspaceId } from "./workspace.js";

export const ExternalApiApplicationId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ExternalApiApplicationId"));

export type ExternalApiApplicationId = typeof ExternalApiApplicationId.Type;

export const ExternalApiApplicationCredentialId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ExternalApiApplicationCredentialId"));

export type ExternalApiApplicationCredentialId =
  typeof ExternalApiApplicationCredentialId.Type;

export const ExternalApiApplicationClientId = Schema.String.check(
  Schema.isMinLength(16),
  Schema.isMaxLength(64),
  Schema.isPattern(/^dxa_[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("@dx/ExternalApiApplicationClientId"));

export type ExternalApiApplicationClientId =
  typeof ExternalApiApplicationClientId.Type;

export const ExternalApiApplicationClientSecret = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(128),
  Schema.isPattern(/^dxs_[A-Za-z0-9_-]+$/),
).pipe(Schema.brand("@dx/ExternalApiApplicationClientSecret"));

export type ExternalApiApplicationClientSecret =
  typeof ExternalApiApplicationClientSecret.Type;

export const ExternalApiApplicationSecretHash = Schema.String.check(
  Schema.isMinLength(64),
  Schema.isMaxLength(64),
  Schema.isPattern(/^[a-f0-9]{64}$/),
).pipe(Schema.brand("@dx/ExternalApiApplicationSecretHash"));

export type ExternalApiApplicationSecretHash =
  typeof ExternalApiApplicationSecretHash.Type;

export const ExternalApiApplicationName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
).pipe(Schema.brand("@dx/ExternalApiApplicationName"));

export type ExternalApiApplicationName = typeof ExternalApiApplicationName.Type;

export const normalizeExternalApiApplicationName = (value: string): string =>
  value.trim();

export const ExternalApiApplicationScope = Schema.Literals([
  "projects:read",
  "projects:write",
  "threads:read",
  "threads:write",
]);

export type ExternalApiApplicationScope =
  typeof ExternalApiApplicationScope.Type;

export const externalApiApplicationScopes = [
  "projects:read",
  "projects:write",
  "threads:read",
  "threads:write",
] as const satisfies ReadonlyArray<ExternalApiApplicationScope>;

export const ExternalApiApplicationScopes = Schema.Array(
  ExternalApiApplicationScope,
).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(externalApiApplicationScopes.length),
  Schema.makeFilter((scopes) => new Set(scopes).size === scopes.length),
);

export type ExternalApiApplicationScopes =
  typeof ExternalApiApplicationScopes.Type;

export const ExternalApiApplicationStatus = Schema.Literals([
  "active",
  "disabled",
  "revoked",
]);

export type ExternalApiApplicationStatus =
  typeof ExternalApiApplicationStatus.Type;

export const ExternalApiApplicationRateLimit = Schema.Int.check(
  Schema.isBetween({ minimum: 10, maximum: 1_000 }),
);

export type ExternalApiApplicationRateLimit =
  typeof ExternalApiApplicationRateLimit.Type;

export const ExternalApiApplicationRotationOverlapSeconds = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 86_400 }),
);

export type ExternalApiApplicationRotationOverlapSeconds =
  typeof ExternalApiApplicationRotationOverlapSeconds.Type;

export const ExternalApiApplicationOwner = Schema.Struct({
  userId: UserId,
  name: Schema.String,
  email: Schema.String,
  activeMember: Schema.Boolean,
});

export type ExternalApiApplicationOwner =
  typeof ExternalApiApplicationOwner.Type;

export const ExternalApiApplicationCredentialSummary = Schema.Struct({
  id: ExternalApiApplicationCredentialId,
  identifier: Schema.String,
  createdAt: Timestamp,
  expiresAt: Schema.optional(Timestamp),
});

export const ExternalApiApplication = Schema.Struct({
  id: ExternalApiApplicationId,
  workspaceId: WorkspaceId,
  clientId: ExternalApiApplicationClientId,
  name: ExternalApiApplicationName,
  owner: ExternalApiApplicationOwner,
  status: ExternalApiApplicationStatus,
  scopes: ExternalApiApplicationScopes,
  rateLimitPerMinute: ExternalApiApplicationRateLimit,
  credential: ExternalApiApplicationCredentialSummary,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  lastUsedAt: Schema.optional(Timestamp),
});

export type ExternalApiApplication = typeof ExternalApiApplication.Type;

export const ExternalApiApplicationAuditEventId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/ExternalApiApplicationAuditEventId"));

export type ExternalApiApplicationAuditEventId =
  typeof ExternalApiApplicationAuditEventId.Type;

export const ExternalApiApplicationAuditEvent = Schema.Struct({
  id: ExternalApiApplicationAuditEventId,
  applicationId: ExternalApiApplicationId,
  actorType: Schema.Literals(["user", "application"]),
  actorId: Schema.String,
  action: Schema.String,
  outcome: Schema.Literals(["success", "rejected", "authorized"]),
  requestId: Schema.String,
  credentialId: Schema.optional(ExternalApiApplicationCredentialId),
  scope: Schema.optional(ExternalApiApplicationScope),
  method: Schema.optional(Schema.String),
  path: Schema.optional(Schema.String),
  createdAt: Timestamp,
});

export type ExternalApiApplicationAuditEvent =
  typeof ExternalApiApplicationAuditEvent.Type;

const applicationCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        v: Schema.Literal(1),
        createdAt: Schema.Number,
        id: ExternalApiApplicationId,
      }),
    ),
  ),
);

const auditCursorCodec = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Struct({
        v: Schema.Literal(1),
        createdAt: Schema.Number,
        id: ExternalApiApplicationAuditEventId,
      }),
    ),
  ),
);

interface ExternalApiApplicationCursorPosition<Id> {
  readonly createdAt: number;
  readonly id: Id;
}

const encodeCursor = <Id>(
  codec: typeof applicationCursorCodec | typeof auditCursorCodec,
  position: ExternalApiApplicationCursorPosition<Id>,
) =>
  Schema.encodeEffect(codec)({ v: 1, ...position } as never).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)),
  );

const decodeCursor = <Id>(
  codec: typeof applicationCursorCodec | typeof auditCursorCodec,
  cursor: unknown,
): Effect.Effect<ExternalApiApplicationCursorPosition<Id>, InvalidPageCursor> =>
  Schema.decodeUnknownEffect(PageCursor)(cursor).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(codec)),
    Effect.map(({ createdAt, id }) => ({ createdAt, id: id as Id })),
    Effect.mapError(() => new InvalidPageCursor()),
  );

export const encodeExternalApiApplicationPageCursor = (
  position: ExternalApiApplicationCursorPosition<ExternalApiApplicationId>,
) => encodeCursor(applicationCursorCodec, position);

export const decodeExternalApiApplicationPageCursor = (cursor: unknown) =>
  decodeCursor<ExternalApiApplicationId>(applicationCursorCodec, cursor);

export const encodeExternalApiApplicationAuditPageCursor = (
  position: ExternalApiApplicationCursorPosition<ExternalApiApplicationAuditEventId>,
) => encodeCursor(auditCursorCodec, position);

export const decodeExternalApiApplicationAuditPageCursor = (cursor: unknown) =>
  decodeCursor<ExternalApiApplicationAuditEventId>(auditCursorCodec, cursor);

export class ExternalApiApplicationNotFound extends Schema.TaggedError<ExternalApiApplicationNotFound>()(
  "ExternalApiApplicationNotFound",
  {},
) {}

export class ExternalApiApplicationUnsupportedScope extends Schema.TaggedError<ExternalApiApplicationUnsupportedScope>()(
  "ExternalApiApplicationUnsupportedScope",
  { scope: Schema.String },
) {}

export class ExternalApiApplicationRateLimited extends Schema.TaggedError<ExternalApiApplicationRateLimited>()(
  "ExternalApiApplicationRateLimited",
  { retryAfterSeconds: Schema.Int },
) {}
