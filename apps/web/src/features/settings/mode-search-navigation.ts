interface SettingsLocation {
  readonly pathname: string;
  readonly search: Readonly<Record<string, unknown>>;
}

/** Mode selection preserves the draft owner; other search changes may not. */
export function isModeOnlyNavigation(
  current: SettingsLocation,
  next: SettingsLocation,
) {
  if (current.pathname !== next.pathname) return false;
  const keys = new Set([
    ...Object.keys(current.search),
    ...Object.keys(next.search),
  ]);
  return [...keys].every(
    (key) =>
      key === "mode" ||
      JSON.stringify(current.search[key]) === JSON.stringify(next.search[key]),
  );
}
