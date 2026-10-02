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

/** A presentation value that owners can pass without subscribing to it. */
export interface PresentationValue<T> {
  readonly get: () => T;
  readonly set: (next: T) => void;
  readonly subscribe: (listener: () => void) => () => void;
}

/** A component-lifetime value for owners without a retained Thread. */
export const createPresentationValue = <T>(
  initial: T,
): PresentationValue<T> => {
  let current = initial;
  const listeners = new Set<() => void>();
  return {
    get: () => current,
    set: (next) => {
      if (Object.is(current, next)) return;
      current = next;
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
};

/**
 * Returns a stable handle to one retained presentation value without
 * subscribing the caller. Only components that render the value should read it
 * through {@link usePresentationValue}, so an owner can pass it down (for
 * example a composer draft) without re-rendering on every change.
 */
export function useThreadPresentationValue<T>(
  key: string,
  initial: T,
): PresentationValue<T> {
  const entry = React.useContext(ThreadPresentationContext);
  // `initial` seeds only the first read, like useState.
  const [seed] = React.useState(() => ({
    initial,
    local: entry === undefined ? createPresentationValue(initial) : undefined,
  }));
  return React.useMemo(() => {
    if (entry === undefined)
      return seed.local ?? createPresentationValue(seed.initial);
    if (!entry.presentation.has(key)) entry.presentation.set(key, seed.initial);
    return {
      get: () =>
        entry.disposed ? seed.initial : (entry.presentation.get(key) as T),
      set: (next) => {
        if (entry.disposed || Object.is(entry.presentation.get(key), next))
          return;
        entry.presentation.set(key, next);
        for (const listener of entry.presentationListeners) listener();
      },
      subscribe: (listener) => {
        entry.presentationListeners.add(listener);
        return () => entry.presentationListeners.delete(listener);
      },
    };
  }, [entry, key, seed]);
}

/** Subscribes the calling component to a presentation value. */
export const usePresentationValue = <T>(value: PresentationValue<T>): T =>
  React.useSyncExternalStore(value.subscribe, value.get, value.get);
