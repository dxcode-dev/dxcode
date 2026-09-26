import type { NavigateOptions } from "@tanstack/react-router";

const SETTINGS_ORIGIN = "https://dx.invalid";

type SettingsNavigationState = Extract<
  Exclude<NonNullable<NavigateOptions["state"]>, true>,
  (...args: never[]) => unknown
>;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const isSettingsRoute = (pathname: string) =>
  pathname === "/settings" ||
  pathname.startsWith("/settings/") ||
  pathname === "/workspaces" ||
  pathname.startsWith("/workspaces/");

export const isValidSettingsReturnTo = (value: unknown): value is string => {
  if (
    typeof value !== "string" ||
    value.length > 2_048 ||
    !value.startsWith("/") ||
    value.startsWith("//")
  )
    return false;
  try {
    const url = new URL(value, SETTINGS_ORIGIN);
    return url.origin === SETTINGS_ORIGIN && !isSettingsRoute(url.pathname);
  } catch {
    return false;
  }
};

export const settingsNavigationState =
  (returnTo: unknown): SettingsNavigationState =>
  (previous: Parameters<SettingsNavigationState>[0]) =>
    isValidSettingsReturnTo(returnTo)
      ? { ...previous, settingsReturnTo: returnTo }
      : previous;

export const settingsReturnToFromState = (
  state: unknown,
): string | undefined => {
  if (!isRecord(state) || !isValidSettingsReturnTo(state.settingsReturnTo))
    return undefined;
  return state.settingsReturnTo;
};
