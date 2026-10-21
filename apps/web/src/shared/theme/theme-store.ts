import type {
  PersonalAppearance,
  PersonalPalette,
  PersonalTerminalTheme,
} from "@dx/domain";
import { Schema } from "effect";

export type Appearance = PersonalAppearance;
export type ResolvedAppearance = Exclude<Appearance, "system">;
export type Palette = PersonalPalette;
export type TerminalTheme = PersonalTerminalTheme;

export const appearanceOptions: ReadonlyArray<{
  readonly value: Appearance;
  readonly label: string;
}> = [
  { value: "system", label: "System default" },
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

export interface ThemePreferences {
  readonly appearance: Appearance;
  readonly resolvedAppearance: ResolvedAppearance;
  readonly palette: Palette;
  readonly terminalTheme: TerminalTheme;
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
