import { type ClassValue, clsx } from "clsx";

/** Joins class names. Parts style from CSS classes, so no utility merging. */
export const cn = (...inputs: ReadonlyArray<ClassValue>) => clsx(inputs);

/** How long ago `timestamp` was; render reads it through `useTimeText`. */
export const formatRelativeTime = (
  timestamp: { readonly epochMilliseconds: number },
  now: number,
) => {
  const elapsed = now - timestamp.epochMilliseconds;
  const minutes = Math.max(0, Math.floor(elapsed / 60_000));
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
};
