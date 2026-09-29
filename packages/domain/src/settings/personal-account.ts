import { Schema } from "effect";
import { ProjectId } from "../projects/project-id.js";
import { UserId } from "../users/user-id.js";
import { ModeId, ModelId } from "./model-routing.js";
import { RunnerProfileId } from "./runner-profile.js";

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

/** A remembered New Thread Project: a Project, or deliberately no Project. */
export const ComposerProjectChoice = Schema.Union([
  Schema.Literal("none"),
  ProjectId,
]);

export type ComposerProjectChoice = typeof ComposerProjectChoice.Type;

/**
 * The last New Thread composer choices for one user. `null` means the user has
 * not chosen that value yet, or (for `model`) chose a mode instead of a model.
 */
export const PersonalComposerDefaults = Schema.Struct({
  project: Schema.NullOr(ComposerProjectChoice),
  mode: Schema.NullOr(ModeId),
  model: Schema.NullOr(ModelId),
  runnerProfileId: Schema.NullOr(RunnerProfileId),
});

export type PersonalComposerDefaults = typeof PersonalComposerDefaults.Type;

/** Absent fields stay unchanged; `model: null` clears a remembered model. */
export const UpdatePersonalComposerDefaultsInput = Schema.Struct({
  project: Schema.optional(ComposerProjectChoice),
  mode: Schema.optional(ModeId),
  model: Schema.optional(Schema.NullOr(ModelId)),
  runnerProfileId: Schema.optional(RunnerProfileId),
});

export type UpdatePersonalComposerDefaultsInput =
  typeof UpdatePersonalComposerDefaultsInput.Type;

export const normalizePersonalAccountDisplayName = (value: string): string =>
  value.trim();

export const normalizePersonalAccountUsername = (value: string): string =>
  value.trim().toLowerCase().replace(/^@/, "");
