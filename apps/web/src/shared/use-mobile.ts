import * as React from "react";

export function useMobile(breakpoint = 767) {
  const query = window.matchMedia(`(max-width: ${breakpoint}px)`);
  const subscribe = (notify: () => void) => {
    query.addEventListener("change", notify);
    return () => query.removeEventListener("change", notify);
  };
  const snapshot = () => query.matches;
  return React.useSyncExternalStore(subscribe, snapshot, snapshot);
}
