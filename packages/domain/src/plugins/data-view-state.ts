/**
 * Reading and writing a view's state, and filling an action's templates
 * from it: shared by Core, which stores state, and the browser, which draws
 * it. Kept apart from the view file's types and its validator, so the
 * browser loads it only with the first view it draws.
 */

const MAX_PATH_SEGMENTS = 8;

// ─── Paths and templates ─────────────────────────────────────────────────

const SEGMENT = /^(?:[A-Za-z_][A-Za-z0-9_-]{0,63}|0|[1-9][0-9]{0,6})$/;

/**
 * A state path's segments: dot-separated keys and array indexes, such as
 * `stats.errors` or `rows.0.status`. `""` is the whole state. Undefined
 * when the path is malformed.
 */
export const parseStatePath = (
  path: string,
): ReadonlyArray<string | number> | undefined => {
  if (path === "") return [];
  if (path.length > 200) return undefined;
  const segments = path.split(".");
  if (segments.length > MAX_PATH_SEGMENTS) return undefined;
  const parsed: Array<string | number> = [];
  for (const segment of segments) {
    if (!SEGMENT.test(segment)) return undefined;
    parsed.push(/^[0-9]/.test(segment) ? Number(segment) : segment);
  }
  return parsed;
};

const FORBIDDEN_KEYS = new Set(["__proto__", "prototype", "constructor"]);

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The value at a path, or undefined when any step is missing. */
export const readStatePath = (
  state: unknown,
  path: string | ReadonlyArray<string | number>,
): unknown => {
  const segments = typeof path === "string" ? parseStatePath(path) : path;
  if (segments === undefined) return undefined;
  let current = state;
  for (const segment of segments) {
    if (typeof segment === "number") {
      if (!Array.isArray(current)) return undefined;
      current = current[segment];
    } else {
      if (!isPlainObject(current) || !Object.hasOwn(current, segment))
        return undefined;
      current = current[segment];
    }
  }
  return current;
};

/**
 * A copy of the state with `value` at the path, creating objects (or arrays,
 * for an index step) on the way. Undefined when the path crosses a value of
 * the wrong kind, such as a key into a list, or names a forbidden key.
 */
export const writeStatePath = (
  state: unknown,
  segments: ReadonlyArray<string | number>,
  value: unknown,
):
  | { readonly ok: true; readonly state: unknown }
  | { readonly ok: false; readonly reason: string } => {
  if (segments.length === 0) return { ok: true, state: value };
  const [head, ...rest] = segments as [
    string | number,
    ...Array<string | number>,
  ];
  if (typeof head === "number") {
    const list =
      state === undefined || state === null
        ? []
        : Array.isArray(state)
          ? [...state]
          : undefined;
    if (list === undefined)
      return {
        ok: false,
        reason: `step ${head} is an index, but the value there is not a list`,
      };
    if (head > list.length)
      return {
        ok: false,
        reason: `index ${head} is past the end of a list of ${list.length}`,
      };
    const inner = writeStatePath(list[head], rest, value);
    if (!inner.ok) return inner;
    list[head] = inner.state;
    return { ok: true, state: list };
  }
  if (FORBIDDEN_KEYS.has(head))
    return { ok: false, reason: `${head} is not allowed as a key` };
  const object =
    state === undefined || state === null
      ? {}
      : isPlainObject(state)
        ? { ...state }
        : undefined;
  if (object === undefined)
    return {
      ok: false,
      reason: `step ${head} is a key, but the value there is not an object`,
    };
  const inner = writeStatePath(object[head], rest, value);
  if (!inner.ok) return inner;
  Object.defineProperty(object, head, {
    value: inner.state,
    enumerable: true,
    writable: true,
    configurable: true,
  });
  return { ok: true, state: object };
};

/** Whether a value counts as empty for `when`, `unless`, and empty states. */
export const isEmptyViewValue = (value: unknown) =>
  value === undefined ||
  value === null ||
  value === false ||
  value === "" ||
  value === 0 ||
  (Array.isArray(value) && value.length === 0) ||
  (isPlainObject(value) && Object.keys(value).length === 0);

/** What a template reads: the state, and the row and form it belongs to. */
export interface DataViewScope {
  readonly state: unknown;
  readonly row?: unknown;
  readonly form?: Readonly<Record<string, unknown>>;
}

/** The value a template path names in a scope. */
export const readScopePath = (scope: DataViewScope, path: string): unknown => {
  const segments = parseStatePath(path.trim());
  if (segments === undefined || segments.length === 0) return undefined;
  const [root, ...rest] = segments;
  if ((root === "row" || root === "item") && scope.row !== undefined)
    return readStatePath(scope.row, rest);
  if (root === "form" && scope.form !== undefined)
    return readStatePath(scope.form, rest);
  return readStatePath(scope.state, segments);
};

const TEMPLATE = /\{\{\s*([^{}]*?)\s*\}\}/g;

const textOf = (value: unknown) =>
  value === undefined || value === null
    ? ""
    : typeof value === "string"
      ? value
      : typeof value === "number" || typeof value === "boolean"
        ? String(value)
        : JSON.stringify(value);

/** A template with each `{{path}}` replaced by the text of its value. */
export const renderViewTemplate = (template: string, scope: DataViewScope) =>
  template.replace(TEMPLATE, (_match, path: string) =>
    textOf(readScopePath(scope, path)),
  );

/**
 * A call's arguments with their templates filled. A string that is one
 * whole `{{path}}` takes the value itself, so a number stays a number.
 */
export const renderViewArgs = (
  value: unknown,
  scope: DataViewScope,
): unknown => {
  if (typeof value === "string") {
    const whole = /^\{\{\s*([^{}]*?)\s*\}\}$/.exec(value);
    return whole === null
      ? renderViewTemplate(value, scope)
      : readScopePath(scope, whole[1] ?? "");
  }
  if (Array.isArray(value))
    return value.map((item) => renderViewArgs(item, scope));
  if (isPlainObject(value))
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderViewArgs(item, scope),
      ]),
    );
  return value;
};
