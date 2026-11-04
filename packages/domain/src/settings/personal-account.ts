import { Schema } from "effect";
import { ProjectId } from "../projects/project-id.js";
import { UserId } from "../users/user-id.js";
import { ModeId, ModelId } from "./model-routing.js";
import { RunnerProfileId } from "./runner-profile.js";
import { AvatarKey } from "./workspace.js";

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

/** How much the web app scales its text (and the layout around it). */
export const PersonalTextSize = Schema.Literals([
  "small",
  "default",
  "large",
  "larger",
]);
export type PersonalTextSize = typeof PersonalTextSize.Type;

/** How wide a Thread's transcript and composer may grow. */
export const PersonalThreadWidth = Schema.Literals([
  "narrow",
  "default",
  "wide",
  "full",
]);
export type PersonalThreadWidth = typeof PersonalThreadWidth.Type;

/** Whether the terminal follows the app's theme or always uses one scheme. */
export const PersonalTerminalAppearance = Schema.Literals([
  "match",
  "light",
  "dark",
]);
export type PersonalTerminalAppearance = typeof PersonalTerminalAppearance.Type;

const cssLength = /^(\d{1,3}(?:\.\d{1,3})?)(px|rem|em|pt|%)?$/;

/** The pixels a Code Font size means: a bare number is pixels. */
export const codeFontSizePixels = (value: string): number | undefined => {
  const match = cssLength.exec(value);
  if (match === null) return undefined;
  const amount = Number(match[1]);
  const unit = match[2] ?? "px";
  const pixels =
    unit === "px"
      ? amount
      : unit === "rem"
        ? amount * 16
        : unit === "pt"
          ? (amount * 4) / 3
          : undefined;
  return pixels !== undefined && pixels >= 6 && pixels <= 48
    ? pixels
    : undefined;
};

/** A line height as a multiple, a percentage, or a px, rem, or em length. */
export const isCodeLineHeight = (value: string): boolean => {
  const match = cssLength.exec(value);
  if (match === null || match[2] === "pt") return false;
  const amount = Number(match[1]);
  switch (match[2]) {
    case undefined:
    case "rem":
    case "em":
      return amount >= 0.5 && amount <= 4;
    case "%":
      return amount >= 50 && amount <= 400;
    default:
      return amount >= 6 && amount <= 96;
  }
};

/**
 * Font families in order of preference, as CSS writes them. Only names,
 * quotes, and commas: the value lands in a CSS custom property.
 */
export const PersonalCodeFontFamily = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(200),
  Schema.isPattern(/^[A-Za-z0-9"'][A-Za-z0-9 ,"'._-]*$/),
);
export type PersonalCodeFontFamily = typeof PersonalCodeFontFamily.Type;

/** A number in pixels, or a CSS length in px, rem, or pt. */
export const PersonalCodeFontSize = Schema.String.check(
  Schema.isMaxLength(16),
  Schema.makeFilter((value) => codeFontSizePixels(value) !== undefined, {
    description: "a size from 6 to 48 pixels in px, rem, or pt",
  }),
);
export type PersonalCodeFontSize = typeof PersonalCodeFontSize.Type;

export const PersonalCodeLineHeight = Schema.String.check(
  Schema.isMaxLength(16),
  Schema.makeFilter(isCodeLineHeight, {
    description: "a multiple, a percentage, or a px, rem, or em length",
  }),
);
export type PersonalCodeLineHeight = typeof PersonalCodeLineHeight.Type;

export const PersonalAccount = Schema.Struct({
  userId: UserId,
  displayName: PersonalAccountDisplayName,
  username: PersonalAccountUsername,
  email: PersonalAccountEmail,
  emailVerified: Schema.Boolean,
  identityAuthority: PersonalAccountIdentityAuthority,
  appearance: PersonalAppearance,
  palette: PersonalPalette,
  terminalTheme: PersonalTerminalTheme,
  textSize: PersonalTextSize,
  threadWidth: PersonalThreadWidth,
  terminalAppearance: PersonalTerminalAppearance,
  /** `null` uses the default Code Font value. */
  codeFontFamily: Schema.NullOr(PersonalCodeFontFamily),
  codeFontSize: Schema.NullOr(PersonalCodeFontSize),
  codeLineHeight: Schema.NullOr(PersonalCodeLineHeight),
  /** Animate the dx logo on the home page (reduced motion still holds it). */
  logoAnimation: Schema.Boolean,
  /** Short sounds for dictation, the mode dial, and other interactions. */
  uiSounds: Schema.Boolean,
  avatarKey: Schema.optional(AvatarKey),
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
  textSize: Schema.optional(PersonalTextSize),
  threadWidth: Schema.optional(PersonalThreadWidth),
  terminalAppearance: Schema.optional(PersonalTerminalAppearance),
  /** `null` clears the value back to the default. */
  codeFontFamily: Schema.optional(Schema.NullOr(PersonalCodeFontFamily)),
  codeFontSize: Schema.optional(Schema.NullOr(PersonalCodeFontSize)),
  codeLineHeight: Schema.optional(Schema.NullOr(PersonalCodeLineHeight)),
  logoAnimation: Schema.optional(Schema.Boolean),
  uiSounds: Schema.optional(Schema.Boolean),
});

export type UpdatePersonalAppearanceInput =
  typeof UpdatePersonalAppearanceInput.Type;

/** Each appearance value the account stores, by its API field name. */
export const PersonalAppearanceFields = {
  appearance: PersonalAppearance,
  palette: PersonalPalette,
  terminalTheme: PersonalTerminalTheme,
  textSize: PersonalTextSize,
  threadWidth: PersonalThreadWidth,
  terminalAppearance: PersonalTerminalAppearance,
  codeFontFamily: Schema.NullOr(PersonalCodeFontFamily),
  codeFontSize: Schema.NullOr(PersonalCodeFontSize),
  codeLineHeight: Schema.NullOr(PersonalCodeLineHeight),
  logoAnimation: Schema.Boolean,
  uiSounds: Schema.Boolean,
} as const satisfies {
  readonly [Field in keyof UpdatePersonalAppearanceInput]-?: Schema.Top;
};

export type PersonalAppearanceField = keyof typeof PersonalAppearanceFields;

export const personalAppearanceFields = Object.keys(
  PersonalAppearanceFields,
) as ReadonlyArray<PersonalAppearanceField>;

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

/**
 * Why a typed display name would be refused, or undefined when the server
 * accepts it. Settings forms and the account route share these messages.
 */
export const personalAccountDisplayNameProblem = (
  value: string,
): string | undefined =>
  Schema.is(PersonalAccountDisplayName)(
    normalizePersonalAccountDisplayName(value),
  )
    ? undefined
    : "Enter a display name between 1 and 128 characters.";

/**
 * Why a typed username would be refused, or undefined when the server accepts
 * it after normalizing (trim, lowercase, leading `@` removed).
 */
export const personalAccountUsernameProblem = (
  value: string,
): string | undefined => {
  const username = normalizePersonalAccountUsername(value);
  if (Schema.is(PersonalAccountUsername)(username)) return undefined;
  if (username === "") return "Enter a username.";
  if (!/^[a-z0-9-]*$/.test(username))
    return "Use only letters, numbers, and hyphens.";
  if (username.length < 3) return "Use at least 3 characters.";
  if (username.length > 32) return "Use at most 32 characters.";
  return "Start and end with a letter or number.";
};

/**
 * Whether a username is the `user-<24 hex>` placeholder dx assigns at sign-up
 * when the email address gives no usable name (the `personal_account` insert
 * trigger), or assigned to everyone before migration 0097. People see such a
 * person by name instead.
 */
export const isDefaultPersonalAccountUsername = (username: string): boolean =>
  /^user-[0-9a-f]{24}$/i.test(username);
