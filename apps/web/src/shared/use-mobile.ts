import * as React from "react";

export function useMobile(breakpoint = 767) {
  const query = React.useMemo(
    () => window.matchMedia(`(max-width: ${breakpoint}px)`),
    [breakpoint],
  );
  const subscribe = React.useCallback(
    (notify: () => void) => {
      query.addEventListener("change", notify);
      return () => query.removeEventListener("change", notify);
    },
    [query],
  );
  const snapshot = React.useCallback(() => query.matches, [query]);
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
