import { Schema } from "effect";
import { UserId } from "../users/user-id.js";

export const PersonalAccountDisplayName = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(128),
).pipe(Schema.brand("@dx/PersonalAccountDisplayName"));

export type PersonalAccountDisplayName = typeof PersonalAccountDisplayName.Type;

export const PersonalAccountUsername = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(32),
  Schema.isPattern(/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])$/),
).pipe(Schema.brand("@dx/PersonalAccountUsername"));

export type PersonalAccountUsername = typeof PersonalAccountUsername.Type;

export const PersonalAccountEmail = Schema.String.check(
  Schema.isMinLength(3),
  Schema.isMaxLength(254),
  Schema.isPattern(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
);

export type PersonalAccountEmail = typeof PersonalAccountEmail.Type;

export const PersonalAccountIdentityAuthority = Schema.Literals([
  "local-password",
  "cloudflare-access",
  "external",
]);

export type PersonalAccountIdentityAuthority =
  typeof PersonalAccountIdentityAuthority.Type;

export const PersonalAppearance = Schema.Literals(["system", "light", "dark"]);
export type PersonalAppearance = typeof PersonalAppearance.Type;

export const PersonalPalette = Schema.Literals(["daydream", "deadpan"]);
export type PersonalPalette = typeof PersonalPalette.Type;

export const PersonalTerminalTheme = Schema.Literals([
  "github",
  "gruvbox",
  "catppuccin",
  "solarized",
  "tokyo-night",
  "rose-pine",
  "one-half",
  "material",
]);
export type PersonalTerminalTheme = typeof PersonalTerminalTheme.Type;

export const PersonalAccount = Schema.Struct({
  userId: UserId,
  displayName: PersonalAccountDisplayName,
  username: PersonalAccountUsername,
  email: PersonalAccountEmail,
  emailVerified: Schema.Boolean,
  identityAuthority: PersonalAccountIdentityAuthority,
  threadCount: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  appearance: PersonalAppearance,
  palette: PersonalPalette,
  terminalTheme: PersonalTerminalTheme,
});

export type PersonalAccount = typeof PersonalAccount.Type;

export const UpdatePersonalAccountInput = Schema.Struct({
  displayName: PersonalAccountDisplayName,
  username: PersonalAccountUsername,
});

export type UpdatePersonalAccountInput = typeof UpdatePersonalAccountInput.Type;

export const UpdatePersonalAppearanceInput = Schema.Struct({
  appearance: Schema.optional(PersonalAppearance),
  palette: Schema.optional(PersonalPalette),
  terminalTheme: Schema.optional(PersonalTerminalTheme),
});

export type UpdatePersonalAppearanceInput =
  typeof UpdatePersonalAppearanceInput.Type;

export const normalizePersonalAccountDisplayName = (value: string): string =>
  value.trim();

export const normalizePersonalAccountUsername = (value: string): string =>
  value.trim().toLowerCase().replace(/^@/, "");
