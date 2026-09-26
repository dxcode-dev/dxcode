import * as React from "react";
import { ThreadPresentationContext } from "./thread-session-context.js";

/** Retains ephemeral presentation in the selected Thread capability. */
export function useThreadPresentation<T>(
  key: string,
  initial: T | (() => T),
): [T, React.Dispatch<React.SetStateAction<T>>] {
  const entry = React.useContext(ThreadPresentationContext);
  const [value, setValue] = React.useState<T>(() => {
    if (entry?.presentation.has(key)) return entry.presentation.get(key) as T;
    const value =
      typeof initial === "function" ? (initial as () => T)() : initial;
    entry?.presentation.set(key, value);
    return value;
  });
  const subscribe = React.useCallback(
    (listener: () => void) => {
      entry?.presentationListeners.add(listener);
      return () => entry?.presentationListeners.delete(listener);
    },
    [entry],
  );
  const snapshot = React.useCallback(
    () =>
      entry !== undefined && !entry.disposed
        ? (entry.presentation.get(key) as T)
        : value,
    [entry, key, value],
  );
  const retainedValue = React.useSyncExternalStore(
    subscribe,
    snapshot,
    snapshot,
  );
  const update = React.useCallback<React.Dispatch<React.SetStateAction<T>>>(
    (next) => {
      if (entry === undefined) {
        setValue(next);
        return;
      }
      if (entry.disposed) return;
      const current = entry.presentation.get(key) as T;
      const value =
        typeof next === "function"
          ? (next as (current: T) => T)(current)
          : next;
      entry.presentation.set(key, value);
      for (const listener of entry.presentationListeners) listener();
    },
    [entry, key],
  );
  return [retainedValue, update];
}
