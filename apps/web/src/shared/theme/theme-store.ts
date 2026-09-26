import type {
  PersonalAppearance,
  PersonalPalette,
  PersonalTerminalTheme,
} from "@dx/domain";

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

export const defaultThemePreferences = Object.freeze({
  appearance: "dark" as Appearance,
  palette: "daydream" as Palette,
  terminalTheme: "github" as TerminalTheme,
});

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
