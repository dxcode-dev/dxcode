import * as React from "react";
import {
  type AppearancePreferences,
  appearancePreferencesOf,
  codeFontFamilyCss,
  codeFontSizeCss,
  defaultAppearancePreferences,
  type ResolvedAppearance,
  rememberBootTheme,
  resolveAppearance,
  type ThemePreferences,
} from "./theme-store.js";

export type AppearanceChange = Partial<AppearancePreferences>;

interface ThemeContextValue extends ThemePreferences {
  /** Saves and applies the given values; the rest stay as they are. */
  readonly update: (change: AppearanceChange) => void;
}

const ignoreThemeChange = () => undefined;

const ThemeContext = React.createContext<ThemeContextValue>({
  ...defaultAppearancePreferences,
  resolvedAppearance: "dark",
  terminalScheme: "dark",
  update: ignoreThemeChange,
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
    root.dataset.textSize = preferences.textSize;
    root.dataset.threadWidth = preferences.threadWidth;
    root.dataset.terminalAppearance = preferences.terminalAppearance;
    // Unset values fall back to the stylesheet and each surface's own size.
    const codeFont = {
      "--font-mono-family":
        preferences.codeFontFamily === null
          ? null
          : codeFontFamilyCss(preferences.codeFontFamily),
      // Surfaces with their own default font (transcript code) read this.
      "--code-font-family":
        preferences.codeFontFamily === null
          ? null
          : codeFontFamilyCss(preferences.codeFontFamily),
      "--code-font-size":
        preferences.codeFontSize === null
          ? null
          : codeFontSizeCss(preferences.codeFontSize),
      "--code-line-height": preferences.codeLineHeight,
    };
    for (const [property, value] of Object.entries(codeFont))
      if (value === null) root.style.removeProperty(property);
      else root.style.setProperty(property, value);
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
  preferences: given,
  onChange = ignoreThemeChange,
  children,
}: {
  /** Values left out use the defaults. */
  readonly preferences: Partial<AppearancePreferences>;
  readonly onChange?: (change: AppearanceChange) => void;
  readonly children: React.ReactNode;
}) {
  const systemPrefersDark = useSystemPrefersDark();
  const stored = appearancePreferencesOf(given);
  const resolvedAppearance = resolveAppearance(
    stored.appearance,
    systemPrefersDark,
  );
  const preferences = {
    ...stored,
    resolvedAppearance,
    terminalScheme:
      stored.terminalAppearance === "match"
        ? resolvedAppearance
        : stored.terminalAppearance,
  };
  useApplyTheme(preferences);
  const value = { ...preferences, update: onChange };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
