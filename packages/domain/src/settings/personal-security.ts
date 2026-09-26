import { Schema } from "effect";
import { Timestamp } from "../persistence/timestamp.js";

export const PersonalApiTokenId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/PersonalApiTokenId"));

export type PersonalApiTokenId = typeof PersonalApiTokenId.Type;

export const PersonalApiTokenName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(64),
).pipe(Schema.brand("@dx/PersonalApiTokenName"));

export type PersonalApiTokenName = typeof PersonalApiTokenName.Type;

export const normalizePersonalApiTokenName = (value: string): string =>
  value.trim();

export const PersonalApiTokenScope = Schema.Literals([
  "projects:read",
  "projects:write",
  "threads:read",
  "threads:write",
  "agents:access",
  "settings:read",
  "settings:write",
]);

export type PersonalApiTokenScope = typeof PersonalApiTokenScope.Type;

export const personalApiTokenScopes = [
  "projects:read",
  "projects:write",
  "threads:read",
  "threads:write",
  "agents:access",
  "settings:read",
  "settings:write",
] as const satisfies ReadonlyArray<PersonalApiTokenScope>;

export const PersonalApiTokenScopes = Schema.Array(PersonalApiTokenScope).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(personalApiTokenScopes.length),
  Schema.makeFilter((scopes) => new Set(scopes).size === scopes.length),
);

export type PersonalApiTokenScopes = typeof PersonalApiTokenScopes.Type;

export const PersonalApiToken = Schema.Struct({
  id: PersonalApiTokenId,
  name: PersonalApiTokenName,
  identifier: Schema.String,
  scopes: PersonalApiTokenScopes,
  createdAt: Timestamp,
  lastUsedAt: Schema.optional(Timestamp),
});

export type PersonalApiToken = typeof PersonalApiToken.Type;

export const PersonalApiTokenPlaintext = Schema.String.check(
  Schema.isMinLength(32),
  Schema.isMaxLength(256),
).pipe(Schema.brand("@dx/PersonalApiTokenPlaintext"));

export type PersonalApiTokenPlaintext = typeof PersonalApiTokenPlaintext.Type;

export const BrowserSessionId = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/BrowserSessionId"));

export type BrowserSessionId = typeof BrowserSessionId.Type;

export const BrowserSession = Schema.Struct({
  id: BrowserSessionId,
  device: Schema.String,
  network: Schema.String,
  isCurrent: Schema.Boolean,
  createdAt: Timestamp,
  lastActiveAt: Timestamp,
  expiresAt: Timestamp,
});

export type BrowserSession = typeof BrowserSession.Type;

export const SecurityPageOffset = Schema.Int.check(
  Schema.isBetween({ minimum: 0, maximum: 10_000 }),
);

export type SecurityPageOffset = typeof SecurityPageOffset.Type;
