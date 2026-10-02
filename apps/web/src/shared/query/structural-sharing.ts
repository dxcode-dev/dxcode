import { Equal } from "effect";

const isPlainArray = (value: unknown): value is unknown[] =>
  Array.isArray(value) && value.length === Object.keys(value).length;

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  Object.prototype.toString.call(value) === "[object Object]" &&
  Object.getPrototypeOf(value) === Object.prototype;

/**
 * TanStack Query's structural sharing, extended to Effect values.
 *
 * Responses are decoded with Effect Schema, so timestamps arrive as `DateTime`
 * instances. TanStack's `replaceEqualDeep` only reuses plain objects and
 * arrays, so every refetch of unchanged data produced new objects all the way
 * up and re-rendered every consumer. This keeps the previous value wherever the
 * new one is deeply equal, comparing Effect values with `Equal.equals`.
 */
export const shareEqualData = <T>(previous: unknown, next: T, depth = 0): T => {
  if (previous === next) return previous as T;
  if (depth > 500) return next;
  if (Equal.isEqual(previous) && Equal.isEqual(next))
    return (Equal.equals(previous, next) ? previous : next) as T;
  const array = isPlainArray(previous) && isPlainArray(next);
  if (!array && !(isPlainObject(previous) && isPlainObject(next))) return next;
  const before = previous as Record<string | number, unknown>;
  const after = next as Record<string | number, unknown>;
  const previousSize = (array ? (previous as unknown[]) : Object.keys(before))
    .length;
  const keys = array ? (next as unknown[]) : Object.keys(after);
  const copy = (array ? new Array(keys.length) : {}) as Record<
    string | number,
    unknown
  >;
  let equalItems = 0;
  for (let index = 0; index < keys.length; index++) {
    const key = array ? index : (keys[index] as string);
    const shared = shareEqualData(before[key], after[key], depth + 1);
    // Define rather than assign: JSON may carry an own "__proto__" key, and
    // assignment would invoke Object.prototype's setter instead.
    Object.defineProperty(copy, key, {
      value: shared,
      enumerable: true,
      writable: true,
      configurable: true,
    });
    if (
      shared === before[key] &&
      (array ? index < previousSize : Object.hasOwn(before, key))
    )
      equalItems++;
  }
  return (
    previousSize === keys.length && equalItems === previousSize
      ? previous
      : copy
  ) as T;
};
