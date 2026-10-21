import * as React from "react";
import {
  type Appearance,
  type Palette,
  type ResolvedAppearance,
  rememberBootTheme,
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
  const query =
    typeof window === "undefined" || window.matchMedia === undefined
      ? undefined
      : window.matchMedia("(prefers-color-scheme: dark)");
  return React.useSyncExternalStore(
    (listener) => {
      query?.addEventListener("change", listener);
      return () => query?.removeEventListener("change", listener);
    },
    () => query?.matches ?? true,
    () => true,
  );
};

/**
 * The app surface in `scheme` as `rgb()`, which browser chrome, the
 * installed app's status bar, and the launch script accept. A custom
 * property computes to its unresolved text (`light-dark(…)`), and the light
 * palette resolves to `oklch()`, so the colour goes through a real property
 * and one canvas pixel.
 */
const resolvedSurfaceColor = (scheme: ResolvedAppearance) => {
  const probe = document.createElement("span");
  probe.style.colorScheme = `only ${scheme}`;
  probe.style.color = "var(--surface)";
  document.body.append(probe);
  const color = getComputedStyle(probe).color;
  probe.remove();
  const context = document.createElement("canvas").getContext("2d");
  if (!context) return undefined;
  context.fillStyle = color;
  context.fillRect(0, 0, 1, 1);
  const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
  return `rgb(${red}, ${green}, ${blue})`;
};

const useApplyTheme = (preferences: ThemePreferences) => {
  React.useLayoutEffect(() => {
    const root = document.documentElement;
    root.dataset.appearance = preferences.appearance;
    root.dataset.resolvedAppearance = preferences.resolvedAppearance;
    root.dataset.palette = preferences.palette;
    root.dataset.windowLayout = "full-window";
    const light = resolvedSurfaceColor("light");
    const dark = resolvedSurfaceColor("dark");
    if (light === undefined || dark === undefined) return;
    const surface = preferences.resolvedAppearance === "light" ? light : dark;
    document
      .querySelector<HTMLMetaElement>('meta[name="theme-color"]')
      ?.setAttribute("content", surface);
    // The launch script painted the saved colour here; keep it current.
    root.style.background = surface;
    root.dataset.themed = "";
    rememberBootTheme({
      appearance: preferences.appearance,
      palette: preferences.palette,
      surface: { light, dark },
    });
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
  const preferences = {
    appearance,
    resolvedAppearance: resolveAppearance(appearance, systemPrefersDark),
    palette,
    terminalTheme,
  };
  useApplyTheme(preferences);
  const value = {
    appearance,
    resolvedAppearance: preferences.resolvedAppearance,
    palette,
    terminalTheme,
    setAppearance: onAppearanceChange,
    setPalette: onPaletteChange,
    setTerminalTheme: onTerminalThemeChange,
  };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
