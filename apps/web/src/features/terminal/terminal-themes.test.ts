import { describe, expect, it } from "vitest";
import { terminalThemeFor } from "./terminal-themes.js";

describe("Ghostty terminal themes", () => {
  it("selects the corresponding light and dark variant", () => {
    expect(terminalThemeFor("github", "light")).toMatchObject({
      background: "#ffffff",
      foreground: "#1f2328",
      blue: "#0969da",
      brightBlue: "#218bff",
    });
    expect(terminalThemeFor("github", "dark")).toMatchObject({
      background: "#0d1117",
      foreground: "#e6edf3",
      blue: "#58a6ff",
      brightBlue: "#79c0ff",
    });
  });

  it("keeps preset families distinct in both appearances", () => {
    expect(terminalThemeFor("gruvbox", "light")).toMatchObject({
      background: "#fbf1c7",
      foreground: "#3c3836",
      brightRed: "#9d0006",
    });
    expect(terminalThemeFor("gruvbox", "dark")).toMatchObject({
      background: "#282828",
      foreground: "#ebdbb2",
      brightRed: "#fb4934",
    });
  });

  it("maps every paired preset to its own light and dark background", () => {
    expect(
      Object.fromEntries(
        [
          "catppuccin",
          "solarized",
          "tokyo-night",
          "rose-pine",
          "one-half",
          "material",
        ].map((theme) => [
          theme,
          [
            terminalThemeFor(
              theme as Parameters<typeof terminalThemeFor>[0],
              "light",
            ).background,
            terminalThemeFor(
              theme as Parameters<typeof terminalThemeFor>[0],
              "dark",
            ).background,
          ],
        ]),
      ),
    ).toEqual({
      catppuccin: ["#eff1f5", "#1e1e2e"],
      solarized: ["#fdf6e3", "#002b36"],
      "tokyo-night": ["#e1e2e7", "#1a1b26"],
      "rose-pine": ["#faf4ed", "#232136"],
      "one-half": ["#fafafa", "#282c34"],
      material: ["#eaeaea", "#232322"],
    });
  });
});
