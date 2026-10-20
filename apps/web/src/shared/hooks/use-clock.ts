import * as React from "react";

const MINUTE_MS = 60_000;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | undefined;
let now = Date.now();

// One timer for every subscriber, and only while something is subscribed.
const schedule = () => {
  timer = setTimeout(() => {
    timer = undefined;
    now = Date.now();
    for (const listener of listeners) listener();
    // A listener may have unsubscribed the last reader, or subscribed one
    // that already scheduled the next tick.
    if (listeners.size > 0 && timer === undefined) schedule();
  }, MINUTE_MS);
};

const subscribe = (listener: () => void) => {
  listeners.add(listener);
  if (timer === undefined) schedule();
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0 && timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
  };
};

// Subscribed readers share one time until the next tick. Before anything
// subscribes, a read takes the current time unless one was taken within the
// last second, so the readers of one render still agree.
const minuteSnapshot = () => {
  const current = Date.now();
  const maxAge = listeners.size === 0 ? 1_000 : MINUTE_MS;
  if (Math.abs(current - now) >= maxAge) now = current;
  return now;
};

/**
 * The current time, at most a minute old, for derivations that tolerate that
 * lag. Render must not read `Date.now()`: the React Compiler caches derived
 * values on their inputs, so a time read during render stays frozen until
 * another input changes.
 */
export const useNowMinute = () =>
  React.useSyncExternalStore(subscribe, minuteSnapshot, minuteSnapshot);

/**
 * Text that depends on the current time, such as "5m ago". Every render reads
 * it with the exact time, and it is re-read every minute while mounted; the
 * component renders again only when the text changes.
 */
export const useTimeText = (text: (now: number) => string) => {
  const read = () => text(Date.now());
  return React.useSyncExternalStore(subscribe, read, read);
};
