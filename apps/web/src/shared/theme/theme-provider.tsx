import * as React from "react";
import { useDocumentTheme } from "../hooks/use-document-theme.js";
import {
  type AppearancePreferences,
  appearancePreferencesOf,
  defaultAppearancePreferences,
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
  useDocumentTheme(preferences);
  const value = { ...preferences, update: onChange };

  return (
    <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
  );
}

export function useTheme() {
  return React.useContext(ThemeContext);
}
