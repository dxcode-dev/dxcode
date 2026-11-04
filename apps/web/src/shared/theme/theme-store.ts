import type {
  PersonalAppearance,
  PersonalPalette,
  PersonalTerminalAppearance,
  PersonalTerminalTheme,
  PersonalTextSize,
  PersonalThreadWidth,
} from "@dx/domain";
import { Schema } from "effect";

export type Appearance = PersonalAppearance;
export type ResolvedAppearance = Exclude<Appearance, "system">;
export type Palette = PersonalPalette;
export type TerminalTheme = PersonalTerminalTheme;
export type TextSize = PersonalTextSize;
export type ThreadWidth = PersonalThreadWidth;
export type TerminalAppearance = PersonalTerminalAppearance;

export const appearanceOptions: ReadonlyArray<{
  readonly value: Appearance;
  readonly label: string;
}> = [
  { value: "system", label: "System" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

export const paletteOptions: ReadonlyArray<{
  readonly value: Palette;
  readonly label: string;
}> = [
  { value: "daydream", label: "Daydream" },
  { value: "deadpan", label: "Deadpan" },
];

export const terminalThemeOptions: ReadonlyArray<{
  readonly value: TerminalTheme;
  readonly label: string;
}> = [
  { value: "github", label: "GitHub Default" },
  { value: "gruvbox", label: "Gruvbox" },
  { value: "catppuccin", label: "Catppuccin" },
  { value: "solarized", label: "Solarized" },
  { value: "tokyo-night", label: "Tokyo Night" },
  { value: "rose-pine", label: "Rosé Pine" },
  { value: "one-half", label: "One Half" },
  { value: "material", label: "Material" },
];

export const textSizeOptions: ReadonlyArray<{
  readonly value: TextSize;
  readonly label: string;
}> = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
  { value: "larger", label: "Larger" },
];

export const threadWidthOptions: ReadonlyArray<{
  readonly value: ThreadWidth;
  readonly label: string;
}> = [
  { value: "narrow", label: "Narrow" },
  { value: "default", label: "Default" },
  { value: "wide", label: "Wide" },
  { value: "full", label: "Full Width" },
];

export const terminalAppearanceOptions: ReadonlyArray<{
  readonly value: TerminalAppearance;
  readonly label: string;
}> = [
  { value: "match", label: "Match Theme" },
  { value: "light", label: "Light" },
  { value: "dark", label: "Dark" },
];

/** The appearance values the account stores. */
export interface AppearancePreferences {
  readonly appearance: Appearance;
  readonly palette: Palette;
  readonly terminalTheme: TerminalTheme;
  readonly textSize: TextSize;
  readonly threadWidth: ThreadWidth;
  readonly terminalAppearance: TerminalAppearance;
  /** `null` uses the default. */
  readonly codeFontFamily: string | null;
  readonly codeFontSize: string | null;
  readonly codeLineHeight: string | null;
  readonly logoAnimation: boolean;
  readonly uiSounds: boolean;
}

export const defaultAppearancePreferences: AppearancePreferences = {
  appearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
  textSize: "default",
  threadWidth: "default",
  terminalAppearance: "match",
  codeFontFamily: null,
  codeFontSize: null,
  codeLineHeight: null,
  logoAnimation: true,
  uiSounds: false,
};

/** The appearance values in `given`, with defaults for those it lacks. */
export const appearancePreferencesOf = (
  given: Partial<AppearancePreferences>,
): AppearancePreferences => ({
  appearance: given.appearance ?? defaultAppearancePreferences.appearance,
  palette: given.palette ?? defaultAppearancePreferences.palette,
  terminalTheme:
    given.terminalTheme ?? defaultAppearancePreferences.terminalTheme,
  textSize: given.textSize ?? defaultAppearancePreferences.textSize,
  threadWidth: given.threadWidth ?? defaultAppearancePreferences.threadWidth,
  terminalAppearance:
    given.terminalAppearance ?? defaultAppearancePreferences.terminalAppearance,
  codeFontFamily: given.codeFontFamily ?? null,
  codeFontSize: given.codeFontSize ?? null,
  codeLineHeight: given.codeLineHeight ?? null,
  logoAnimation:
    given.logoAnimation ?? defaultAppearancePreferences.logoAnimation,
  uiSounds: given.uiSounds ?? defaultAppearancePreferences.uiSounds,
});

/** The stylesheet's monospace stack, which a Code Font family falls back to. */
export const defaultCodeFontFamily =
  '"SFMono-Regular", Consolas, "Liberation Mono", monospace';

const genericFontFamilies = new Set([
  "monospace",
  "ui-monospace",
  "sans-serif",
  "serif",
  "system-ui",
]);

/**
 * A Code Font family list as CSS: each name quoted (so names with digits or
 * spaces stay valid), then the default stack.
 */
export const codeFontFamilyCss = (family: string | null) => {
  const names = (family ?? "")
    .split(",")
    .map((name) =>
      name
        .trim()
        .replace(/^["']|["']$/g, "")
        .trim(),
    )
    .filter((name) => name.length > 0)
    .map((name) =>
      genericFontFamilies.has(name.toLowerCase()) ? name : `"${name}"`,
    );
  return [...names, defaultCodeFontFamily].join(", ");
};

/** A Code Font size as CSS: a bare number means pixels. */
export const codeFontSizeCss = (size: string) =>
  /^[\d.]+$/.test(size) ? `${size}px` : size;

export interface ThemePreferences extends AppearancePreferences {
  readonly resolvedAppearance: ResolvedAppearance;
  /** The scheme the terminal uses after its Light or Dark choice. */
  readonly terminalScheme: ResolvedAppearance;
}

export const resolveAppearance = (
  appearance: Appearance,
  systemPrefersDark: boolean,
): ResolvedAppearance =>
  appearance === "system" ? (systemPrefersDark ? "dark" : "light") : appearance;

/**
 * The last applied theme, kept on this device so the next launch paints in
 * it before any script or stylesheet loads (the inline script in
 * index.html reads it). It holds the surface colour for both schemes so a
 * "system" appearance can follow the device at launch.
 */
export const bootThemeStorageKey = "dx:boot-theme:v1";

const SurfaceColour = Schema.String.check(
  Schema.isPattern(/^rgb\(\d{1,3}, \d{1,3}, \d{1,3}\)$/),
);

const BootTheme = Schema.Struct({
  version: Schema.Literal(1),
  appearance: Schema.Literals(["system", "light", "dark"]),
  palette: Schema.Literals(["daydream", "deadpan"]),
  surface: Schema.Struct({ light: SurfaceColour, dark: SurfaceColour }),
});

export const rememberBootTheme = (theme: {
  readonly appearance: Appearance;
  readonly palette: Palette;
  readonly surface: { readonly light: string; readonly dark: string };
}) => {
  try {
    const envelope = Schema.decodeUnknownSync(BootTheme)({
      version: 1,
      ...theme,
    });
    window.localStorage.setItem(bootThemeStorageKey, JSON.stringify(envelope));
  } catch {
    // Storage may be full or disabled; the next launch uses the defaults.
  }
};
