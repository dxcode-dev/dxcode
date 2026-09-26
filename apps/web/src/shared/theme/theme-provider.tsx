import * as React from "react";
import {
  type Appearance,
  type Palette,
  resolveAppearance,
  type TerminalTheme,
  type ThemePreferences,
} from "./theme-store.js";

interface ThemeContextValue extends ThemePreferences {
  readonly setAppearance: (appearance: Appearance) => void;
  readonly setPalette: (palette: Palette) => void;
  readonly setTerminalTheme: (terminalTheme: TerminalTheme) => void;
}

const ignoreThemeChange = () => undefined;

const ThemeContext = React.createContext<ThemeContextValue>({
  appearance: "dark",
  resolvedAppearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
  setAppearance: ignoreThemeChange,
  setPalette: ignoreThemeChange,
  setTerminalTheme: ignoreThemeChange,
});

const useSystemPrefersDark = () => {
  const query = React.useMemo(
    () =>
      typeof window === "undefined" || window.matchMedia === undefined
        ? undefined
        : window.matchMedia("(prefers-color-scheme: dark)"),
    [],
  );
  return React.useSyncExternalStore(
    React.useCallback(
      (listener) => {
        query?.addEventListener("change", listener);
        return () => query?.removeEventListener("change", listener);
      },
      [query],
    ),
    () => query?.matches ?? true,
    () => true,
  );
};

const useApplyTheme = (preferences: ThemePreferences) => {
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = preferences.appearance;
    root.dataset.resolvedAppearance = preferences.resolvedAppearance;
    root.dataset.palette = preferences.palette;
    root.dataset.windowLayout = "full-window";
    const themeColor = getComputedStyle(root)
      .getPropertyValue("--background")
      .trim();
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", themeColor);
  }, [preferences]);
};

export function ThemeProvider({
  appearance,
  palette,
  terminalTheme = "github",
  onAppearanceChange,
  onPaletteChange,
  onTerminalThemeChange = ignoreThemeChange,
  children,
}: {
  readonly appearance: Appearance;
  readonly palette: Palette;
  readonly terminalTheme?: TerminalTheme;
  readonly onAppearanceChange: (appearance: Appearance) => void;
  readonly onPaletteChange: (palette: Palette) => void;
  readonly onTerminalThemeChange?: (terminalTheme: TerminalTheme) => void;
  readonly children: React.ReactNode;
}) {
  const systemPrefersDark = useSystemPrefersDark();
  const preferences = React.useMemo(
    () => ({
      appearance,
      resolvedAppearance: resolveAppearance(appearance, systemPrefersDark),
      palette,
      terminalTheme,
    }),
    [appearance, palette, systemPrefersDark, terminalTheme],
  );
  useApplyTheme(preferences);
  const value = React.useMemo(
    () => ({
      appearance,
      resolvedAppearance: preferences.resolvedAppearance,
      palette,
      terminalTheme,
      setAppearance: onAppearanceChange,
      setPalette: onPaletteChange,
      setTerminalTheme: onTerminalThemeChange,
    }),
    [
      appearance,
      onAppearanceChange,
      onPaletteChange,
      onTerminalThemeChange,
      palette,
      preferences.resolvedAppearance,
      terminalTheme,
    ],
  );

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
