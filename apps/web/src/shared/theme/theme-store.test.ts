import { describe, expect, it } from "vitest";
import {
  appearanceOptions,
  defaultThemePreferences,
  paletteOptions,
  resolveAppearance,
  terminalThemeOptions,
} from "./theme-store.js";

describe("theme preferences", () => {
  it("exposes only account-backed appearance and palette choices", () => {
    expect(defaultThemePreferences).toEqual({
      appearance: "dark",
      palette: "daydream",
      terminalTheme: "github",
    });
    expect(appearanceOptions.map(({ value }) => value)).toEqual([
      "system",
      "light",
      "dark",
    ]);
    expect(paletteOptions.map(({ value }) => value)).toEqual([
      "daydream",
      "deadpan",
    ]);
    expect(terminalThemeOptions.map(({ value }) => value)).toEqual([
      "github",
      "gruvbox",
      "catppuccin",
      "solarized",
      "tokyo-night",
      "rose-pine",
      "one-half",
      "material",
    ]);
  });

  it("resolves system appearance in both directions", () => {
    expect(resolveAppearance("system", false)).toBe("light");
    expect(resolveAppearance("system", true)).toBe("dark");
    expect(resolveAppearance("light", true)).toBe("light");
    expect(resolveAppearance("dark", false)).toBe("dark");
  });
});
